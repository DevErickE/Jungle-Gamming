import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DataSource } from 'typeorm';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import pg from 'pg';
import { SubmitWagerUseCase } from '../../src/application/wagering/submit-wager.use-case.ts';
import { createSqsClient, ensureQueues, type QueueSet } from '../../src/infrastructure/messaging/sqs.ts';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer.ts';
import { OutboxPublisher, type EventSender } from '../../src/infrastructure/messaging/outbox-publisher.ts';
import { SqsEventSender } from '../../src/infrastructure/messaging/sqs-event-sender.ts';
import { createOrm } from '../../src/infrastructure/persistence/orm.ts';
import { FailureCode } from '../../src/domain/wagering/failure-code.ts';
import {
  TEST_DATABASE_URL,
  assertLedgerMatchesBalance,
  openWallet,
  resetTestDatabase,
} from '../helpers/database.ts';

// LocalStack (SQS). Configure com AWS_ENDPOINT_URL; o padrão é o LocalStack local.
process.env.AWS_ENDPOINT_URL ??= 'http://127.0.0.1:4566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

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

/** Cada teste usa filas próprias, com nomes únicos, para não interferir nos outros. */
async function makeQueues(visibilitySeconds = 1, maxReceiveCount = 3): Promise<QueueSet> {
  const id = Bun.randomUUIDv7().replace(/-/g, '').slice(0, 16);
  return ensureQueues(
    sqs,
    { wager: `wager-${id}.fifo`, dlq: `wager-dlq-${id}.fifo`, events: `events-${id}.fifo` },
    { visibilityTimeoutSeconds: visibilitySeconds, maxReceiveCount },
  );
}

interface Wallet {
  id: string;
  playerId: string;
}

/** Mensagem no formato da seção 10 da spec. */
function wagerMessage(
  wallet: Wallet,
  kind: string,
  externalTransactionId: string,
  amount: string,
  referenceExternalTransactionId: string | null = null,
  messageId = `msg-${Bun.randomUUIDv7()}`,
) {
  return {
    messageId,
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
      kind,
      money: { amount, currency: 'BRL' },
      referenceExternalTransactionId,
    },
  };
}

/** Envia para a fila FIFO, com grupo = wallet (ordem por carteira). */
async function send(queueUrl: string, body: unknown | string): Promise<void> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const groupId = typeof body === 'string' ? 'malformed' : (body as { data: { walletId: string } }).data.walletId;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: payload,
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

/** Lê e apaga tudo que estiver na fila. Retorna os corpos. */
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

/** Processa lotes até `done()` ser verdadeiro. Falha se estourar o tempo. */
async function drain(consumer: WagerConsumer, done: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await consumer.pollOnce();
    if (await done()) {
      return;
    }
  }
  throw new Error('timed out waiting for the consumer');
}

async function balanceOf(walletId: string): Promise<string> {
  const result = await client.query<{ balance_minor: string }>(
    'SELECT balance_minor FROM wallets WHERE id = $1',
    [walletId],
  );
  return result.rows[0]?.balance_minor ?? 'missing';
}

async function debitCount(walletId: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
    [walletId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function statusOf(externalTransactionId: string): Promise<{ status: string; failure_code: string | null }> {
  const result = await client.query<{ status: string; failure_code: string | null }>(
    'SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = $1',
    [externalTransactionId],
  );
  return result.rows[0] ?? { status: 'missing', failure_code: null };
}

async function inboxCount(messageId: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM inbox_messages WHERE consumer_name = 'wager-transactions' AND message_id = $1",
    [messageId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

describe('consumidor da fila de transações (SQS real)', () => {
  test('processa uma BET vinda da fila e apaga a mensagem depois do commit', async () => {
    const queues = await makeQueues();
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const consumer = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, useCase, { waitTimeSeconds: 1 });
    const message = wagerMessage(wallet, 'BET', 'mq-bet-1', '25.00');

    await send(queues.queueUrl, message);
    await drain(consumer, async () => (await balanceOf(wallet.id)) === '7500');

    expect(await statusOf('mq-bet-1')).toMatchObject({ status: 'PROCESSED' });
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await receiveAll(queues.queueUrl)).toEqual([]);
    await assertLedgerMatchesBalance(client, wallet.id);
  }, 60_000);

  test('a mesma mensagem entregue duas vezes (mesmo messageId) tem efeito único', async () => {
    const queues = await makeQueues();
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const consumer = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, useCase, { waitTimeSeconds: 1 });
    const message = wagerMessage(wallet, 'BET', 'mq-dup-1', '25.00');

    await send(queues.queueUrl, message);
    await send(queues.queueUrl, message);
    await drain(consumer, async () => (await balanceOf(wallet.id)) === '7500');
    // Consome o restante: a segunda entrega precisa passar pela inbox sem efeito.
    while ((await consumer.pollOnce()) > 0) {
      // drena até a fila esvaziar
    }

    expect(await balanceOf(wallet.id)).toBe('7500');
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
  }, 60_000);

  test('crash depois do commit e antes do ack: a mensagem volta e não duplica o débito', async () => {
    const queues = await makeQueues(1);
    const wallet = await openWallet(client, { initialMinor: 10000 });
    let hookCalls = 0;
    const consumer = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, useCase, {
      waitTimeSeconds: 1,
      beforeAck: async () => {
        hookCalls += 1;
        if (hookCalls === 1) {
          throw new Error('simulated crash before ack');
        }
      },
    });
    const message = wagerMessage(wallet, 'BET', 'mq-crash-1', '25.00');

    await send(queues.queueUrl, message);
    await drain(consumer, async () => hookCalls >= 2 && (await balanceOf(wallet.id)) === '7500');
    while ((await consumer.pollOnce()) > 0) {
      // drena o que restou
    }

    expect(hookCalls).toBeGreaterThanOrEqual(2);
    expect(await balanceOf(wallet.id)).toBe('7500');
    expect(await debitCount(wallet.id)).toBe(1);
    await assertLedgerMatchesBalance(client, wallet.id);
  }, 60_000);

  test('mensagem malformada vai para a DLQ e sai da fila principal', async () => {
    const queues = await makeQueues();
    const consumer = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, useCase, { waitTimeSeconds: 1 });

    await send(queues.queueUrl, 'nao-e-json');
    await consumer.pollOnce();

    expect(await receiveAll(queues.queueUrl)).toEqual([]);
    expect(await receiveAll(queues.dlqUrl)).toEqual(['nao-e-json']);
  }, 60_000);

  test('erro transitório reentrega até o limite e depois cai na DLQ', async () => {
    const queues = await makeQueues(1, 3);
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const flaky = {
      execute: async () => {
        throw Object.assign(new Error('connection lost'), { code: '08006' });
      },
    } as unknown as SubmitWagerUseCase;
    const consumer = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, flaky, {
      waitTimeSeconds: 1,
      backoffBaseSeconds: 0,
    });
    const message = wagerMessage(wallet, 'BET', 'mq-transient-1', '25.00');

    await send(queues.queueUrl, message);
    const deadline = Date.now() + 20_000;
    let dead: string[] = [];
    while (Date.now() < deadline && dead.length === 0) {
      await consumer.pollOnce();
      dead = await receiveAll(queues.dlqUrl);
    }

    expect(dead.length).toBe(1);
    expect(JSON.parse(dead[0] ?? '{}').messageId).toBe(message.messageId);
    expect(await balanceOf(wallet.id)).toBe('10000');
  }, 60_000);

  test('erro de negócio é confirmado (ack) e não vai para a DLQ', async () => {
    const queues = await makeQueues();
    const consumer = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, useCase, { waitTimeSeconds: 1 });
    const unknownWallet = { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() };

    await send(queues.queueUrl, wagerMessage(unknownWallet, 'BET', 'mq-missing-1', '1.00'));
    await consumer.pollOnce();

    expect(await receiveAll(queues.queueUrl)).toEqual([]);
    expect(await receiveAll(queues.dlqUrl)).toEqual([]);
  }, 60_000);

  test('ROLLBACK entregue antes da BET fica pendente e é concluído depois', async () => {
    const queues = await makeQueues();
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const consumer = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, useCase, { waitTimeSeconds: 1 });

    // Na mesma wallet (mesmo grupo FIFO): o rollback chega primeiro.
    await send(queues.queueUrl, wagerMessage(wallet, 'ROLLBACK', 'mq-late-rb', '30.00', 'mq-late-bet'));
    await drain(consumer, async () => (await statusOf('mq-late-rb')).status === 'PENDING_REFERENCE');
    expect(await balanceOf(wallet.id)).toBe('10000');

    await send(queues.queueUrl, wagerMessage(wallet, 'BET', 'mq-late-bet', '30.00'));
    await drain(consumer, async () => (await statusOf('mq-late-bet')).status === 'PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('7000');

    await useCase.reprocessPending(new Date(Date.now() + 10_000), 50);
    expect(await statusOf('mq-late-rb')).toMatchObject({ status: 'PROCESSED' });
    expect(await balanceOf(wallet.id)).toBe('10000');
    await assertLedgerMatchesBalance(client, wallet.id);
  }, 60_000);

  test('reinício do consumidor no meio do lote: a consistência final se mantém', async () => {
    const queues = await makeQueues();
    const wallet = await openWallet(client, { initialMinor: 10000 });

    for (let i = 0; i < 20; i++) {
      await send(queues.queueUrl, wagerMessage(wallet, 'BET', `mq-restart-${i}`, '5.00'));
    }

    const first = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, useCase, { waitTimeSeconds: 1 });
    await first.pollOnce();
    await first.stop();

    const second = new WagerConsumer(sqs, queues.queueUrl, queues.dlqUrl, useCase, { waitTimeSeconds: 1 });
    await drain(second, async () => (await balanceOf(wallet.id)) === '0');

    expect(await debitCount(wallet.id)).toBe(20);
    await assertLedgerMatchesBalance(client, wallet.id);
  }, 60_000);
});

/** Marca eventos antigos como publicados, para que cada teste da outbox conte só os seus. */
async function clearOutbox(): Promise<void> {
  await client.query('UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL');
}

describe('publicação da outbox (SQS real)', () => {
  test('publica os eventos gravados na transação e marca como publicados', async () => {
    await clearOutbox();
    const queues = await makeQueues();
    const wallet = await openWallet(client, { initialMinor: 10000 });
    for (let i = 0; i < 3; i++) {
      await useCase.execute({
        idempotencyKey: `pub-${i}`,
        providerId: 'provider-a',
        externalTransactionId: `pub-${i}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      });
    }

    const publisher = new OutboxPublisher(orm, new SqsEventSender(sqs, queues.eventsUrl));
    const published = await publisher.publishDue(new Date(Date.now() + 1000));
    const events = await receiveAll(queues.eventsUrl);

    expect(published).toBe(6);
    expect(events.length).toBe(6);
    const pending = await client.query("SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL");
    expect(pending.rows[0]?.n).toBe('0');
  }, 60_000);

  test('dois publishers concorrentes sobre a mesma outbox: todo evento sai, nenhum duplicado', async () => {
    await clearOutbox();
    const queues = await makeQueues();
    const wallet = await openWallet(client, { initialMinor: 1000000 });
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        useCase.execute({
          idempotencyKey: `two-${i}`,
          providerId: 'provider-a',
          externalTransactionId: `two-${i}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'g',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        }),
      ),
    );

    const total = Number(
      (await client.query<{ n: string }>('SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL')).rows[0]?.n ?? 0,
    );
    expect(total).toBe(60);

    const sender = new SqsEventSender(sqs, queues.eventsUrl);
    const publisherA = new OutboxPublisher(orm, sender, 5);
    const publisherB = new OutboxPublisher(orm, sender, 5);
    const future = new Date(Date.now() + 1000);
    for (let round = 0; round < 50; round++) {
      await Promise.all([publisherA.publishDue(future), publisherB.publishDue(future)]);
      const pending = await client.query("SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL");
      if (pending.rows[0]?.n === '0') {
        break;
      }
    }

    const pending = await client.query("SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL");
    expect(pending.rows[0]?.n).toBe('0');

    const events = await receiveAll(queues.eventsUrl);
    const ids = events.map((body) => (JSON.parse(body) as { eventId: string }).eventId);
    expect(ids.length).toBe(total);
    expect(new Set(ids).size).toBe(total);
  }, 60_000);

  test('falha ao publicar é reagendada com backoff e publicada depois', async () => {
    await clearOutbox();
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute({
      idempotencyKey: 'retry-evt',
      providerId: 'provider-a',
      externalTransactionId: 'retry-evt',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    });

    const delivered: string[] = [];
    let failures = 0;
    const flakySender: EventSender = {
      send: async (event) => {
        if (failures === 0) {
          failures += 1;
          throw new Error('SQS unavailable');
        }
        delivered.push(event.id);
      },
    };
    const publisher = new OutboxPublisher(orm, flakySender);

    // Um dos dois eventos falha na primeira tentativa; o outro sai normalmente.
    const now = new Date();
    expect(await publisher.publishDue(now)).toBe(1);
    const failed = await client.query(
      'SELECT attempts FROM outbox_messages WHERE published_at IS NULL',
    );
    expect(failed.rows).toEqual([{ attempts: 1 }]);

    // Ainda dentro do backoff: nada a publicar.
    expect(await publisher.publishDue(new Date(now.getTime() + 500))).toBe(0);
    // Depois do backoff: publica o que faltava.
    expect(await publisher.publishDue(new Date(now.getTime() + 60_000))).toBe(1);
    expect(new Set(delivered).size).toBe(2);
    const pending = await client.query('SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL');
    expect(pending.rows[0]?.n).toBe('0');
  }, 60_000);
});
