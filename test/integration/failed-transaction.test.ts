import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DataSource } from 'typeorm';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import pg from 'pg';
import { SubmitWagerUseCase, type SubmitWagerInput } from '../../src/application/wagering/submit-wager.use-case.ts';
import { FailureCode } from '../../src/domain/wagering/failure-code.ts';
import { createSqsClient, ensureQueues, type QueueSet } from '../../src/infrastructure/messaging/sqs.ts';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer.ts';
import { createOrm } from '../../src/infrastructure/persistence/orm.ts';
import { TEST_DATABASE_URL, assertLedgerMatchesBalance, openWallet, resetTestDatabase } from '../helpers/database.ts';

// LocalStack (SQS). Mesma configuração dos demais testes de mensageria.
process.env.AWS_ENDPOINT_URL ??= 'http://127.0.0.1:4566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

const MAX_RECEIVE_COUNT = 3;

let orm: DataSource;
let useCase: SubmitWagerUseCase;
let client: pg.Client;
let sqs: SQSClient;

beforeAll(async () => {
  await resetTestDatabase();
  orm = await createOrm(TEST_DATABASE_URL);
  useCase = new SubmitWagerUseCase(orm);
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  sqs = createSqsClient();
});

afterAll(async () => {
  sqs?.destroy();
  await client?.end();
  await orm?.destroy();
});

async function makeQueues(): Promise<QueueSet> {
  const id = Bun.randomUUIDv7().replace(/-/g, '').slice(0, 16);
  return ensureQueues(
    sqs,
    { wager: `wager-${id}.fifo`, dlq: `wager-dlq-${id}.fifo`, events: `events-${id}.fifo` },
    { visibilityTimeoutSeconds: 1, maxReceiveCount: MAX_RECEIVE_COUNT },
  );
}

/** Mensagem no formato da seção 10 da spec. */
function wagerMessage(wallet: { id: string; playerId: string }, externalTransactionId: string, amount: string) {
  return {
    messageId: `msg-${Bun.randomUUIDv7()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
      referenceExternalTransactionId: null,
    },
  };
}

async function send(queueUrl: string, body: unknown): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: (body as { data: { walletId: string } }).data.walletId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

/** Lê e apaga tudo que estiver na fila. */
async function receiveAll(queueUrl: string): Promise<string[]> {
  const bodies: string[] = [];
  let emptyRounds = 0;
  while (emptyRounds < 2) {
    const response = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    const messages = response.Messages ?? [];
    if (messages.length === 0) {
      emptyRounds += 1;
      continue;
    }
    emptyRounds = 0;
    for (const message of messages) {
      bodies.push(message.Body ?? '');
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return bodies;
}

async function balanceOf(walletId: string): Promise<string> {
  const result = await client.query<{ balance_minor: string }>('SELECT balance_minor FROM wallets WHERE id = $1', [walletId]);
  return result.rows[0]?.balance_minor ?? 'missing';
}

async function transactionRow(externalTransactionId: string) {
  const result = await client.query<{ id: string; status: string; failure_code: string | null; processed_at: Date | null }>(
    'SELECT id, status, failure_code, processed_at FROM wager_transactions WHERE external_transaction_id = $1',
    [externalTransactionId],
  );
  return result.rows[0] ?? null;
}

async function ledgerCountFor(transactionId: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE transaction_id = $1',
    [transactionId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Entrada equivalente à mensagem da fila, para repetir a mesma transação pela API. */
function sameInput(wallet: { id: string; playerId: string }, externalTransactionId: string, amount: string): SubmitWagerInput {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId: null,
  };
}

describe('falha permanente de infraestrutura vira FAILED', () => {
  test('falha que persiste até o limite: transação FAILED, sem efeito no saldo, mensagem na DLQ', async () => {
    const queues = await makeQueues();
    const wallet = await openWallet(client, { initialMinor: 10000 });
    // A execução falha sempre com erro de conexão. O registro da falha usa o caso de uso real.
    const flaky = {
      execute: async () => {
        throw Object.assign(new Error('connection lost'), { code: '08006' });
      },
      recordInfrastructureFailure: (input: SubmitWagerInput) => useCase.recordInfrastructureFailure(input),
    } as unknown as SubmitWagerUseCase;
    const consumer = new WagerConsumer(
      sqs,
      queues.queueUrl,
      queues.dlqUrl,
      flaky,
      { waitTimeSeconds: 1, backoffBaseSeconds: 0, maxReceiveCount: MAX_RECEIVE_COUNT },
    );
    const message = wagerMessage(wallet, 'failed-bet-1', '25.00');

    await send(queues.queueUrl, message);
    const deadline = Date.now() + 30_000;
    let dead: string[] = [];
    while (Date.now() < deadline && dead.length === 0) {
      await consumer.pollOnce();
      dead = await receiveAll(queues.dlqUrl);
    }

    expect(dead.length).toBe(1);
    expect(JSON.parse(dead[0] ?? '{}').messageId).toBe(message.messageId);

    const row = await transactionRow('failed-bet-1');
    expect(row?.status).toBe('FAILED');
    expect(row?.failure_code).toBe(FailureCode.InfrastructureFailure);
    expect(row?.processed_at).not.toBeNull();
    expect(await ledgerCountFor(row?.id ?? '')).toBe(0);
    expect(await balanceOf(wallet.id)).toBe('10000');
    await assertLedgerMatchesBalance(client, wallet.id);
  }, 60_000);

  test('repetir a transação FAILED pela API devolve o status FAILED como replay, sem debitar', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const flaky = {
      execute: async () => {
        throw Object.assign(new Error('connection lost'), { code: '08006' });
      },
      recordInfrastructureFailure: (input: SubmitWagerInput) => useCase.recordInfrastructureFailure(input),
    } as unknown as SubmitWagerUseCase;
    const queues = await makeQueues();
    const consumer = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, flaky, {
      waitTimeSeconds: 1,
      backoffBaseSeconds: 0,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    });
    await send(queues.queueUrl, wagerMessage(wallet, 'failed-replay-1', '25.00'));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (await transactionRow('failed-replay-1')) === null) {
      await consumer.pollOnce();
    }

    const replay = await useCase.execute(sameInput(wallet, 'failed-replay-1', '25.00'));

    expect(replay.status).toBe('FAILED');
    expect(replay.failureCode).toBe(FailureCode.InfrastructureFailure);
    expect(replay.idempotentReplay).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('10000');
  }, 60_000);
});
