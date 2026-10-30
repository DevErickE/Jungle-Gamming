import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { DataSource } from 'typeorm';
import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import pg from 'pg';
import { SubmitWagerUseCase } from '../../src/application/wagering/submit-wager.use-case.ts';
import { createSqsClient, ensureQueues, type QueueSet } from '../../src/infrastructure/messaging/sqs.ts';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher.ts';
import { SqsEventSender } from '../../src/infrastructure/messaging/sqs-event-sender.ts';
import { createOrm } from '../../src/infrastructure/persistence/orm.ts';
import { TEST_DATABASE_URL, openWallet, resetTestDatabase } from '../helpers/database.ts';

// LocalStack (SQS). Mesma configuração dos demais testes de mensageria.
process.env.AWS_ENDPOINT_URL ??= 'http://127.0.0.1:4566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

const PUBLISHER_WORKER = fileURLToPath(new URL('../fixtures/outbox-publisher-worker.ts', import.meta.url));

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
    { visibilityTimeoutSeconds: 1, maxReceiveCount: 3 },
  );
}

/** Lê as mensagens sem apagá-las: com visibilidade zero, elas voltam a ficar disponíveis. */
async function peek(queueUrl: string): Promise<string[]> {
  const response = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 0 }),
  );
  return (response.Messages ?? []).map((message) => message.Body ?? '');
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

async function pendingCount(): Promise<number> {
  const result = await client.query<{ n: string }>('SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL');
  return Number(result.rows[0]?.n ?? 0);
}

async function publishedAt(eventId: string): Promise<Date | null> {
  const result = await client.query<{ published_at: Date | null }>(
    'SELECT published_at FROM outbox_messages WHERE id = $1',
    [eventId],
  );
  return result.rows[0]?.published_at ?? null;
}

describe('publicador da outbox que morre no meio (processo real)', () => {
  test('evento enviado e não confirmado: outro publicador assume e a fila não recebe cópia duplicada', async () => {
    await client.query('DELETE FROM outbox_messages');
    const queues = await makeQueues();
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute({
      idempotencyKey: 'crash-bet-1',
      providerId: 'provider-a',
      externalTransactionId: 'crash-bet-1',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    });
    const pendingBefore = await pendingCount();
    expect(pendingBefore).toBeGreaterThan(0);

    // 1. O publicador morre logo depois de enviar um evento, antes de confirmar a marcação.
    const proc = Bun.spawn([process.execPath, PUBLISHER_WORKER, queues.eventsUrl], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    // No Windows, o SIGKILL aparece como código de saída diferente de zero, e não como sinal.
    // Sem stderr, a saída é a morte do processo, e não um erro tratado.
    expect(exitCode).not.toBe(0);
    expect(stderr).toBe('');

    // 2. A mensagem chegou ao SQS antes da morte.
    const sentBeforeCrash = await peek(queues.eventsUrl);
    expect(sentBeforeCrash.length).toBe(1);
    const sentEventId = (JSON.parse(sentBeforeCrash[0] ?? '{}') as { eventId: string }).eventId;

    // 3. A marcação não foi confirmada, então o evento continua pendente no banco.
    expect(await publishedAt(sentEventId)).toBeNull();
    expect(await pendingCount()).toBe(pendingBefore);

    // 4. Outro publicador assume: reenvia o que estava pendente, inclusive o evento já enviado.
    const takeover = new OutboxPublisher(orm, new SqsEventSender(sqs, queues.eventsUrl));
    const published = await takeover.publishDue(new Date(Date.now() + 1000));
    expect(published).toBe(pendingBefore);
    expect(await pendingCount()).toBe(0);
    expect(await publishedAt(sentEventId)).not.toBeNull();

    // 5. A deduplicação do SQS descartou a cópia do reenvio: cada evento aparece uma única vez.
    const bodies = await receiveAll(queues.eventsUrl);
    const ids = bodies.map((body) => (JSON.parse(body) as { eventId: string }).eventId);
    expect(ids.length).toBe(pendingBefore);
    expect(new Set(ids).size).toBe(pendingBefore);
    expect(ids).toContain(sentEventId);
  }, 90_000);
});
