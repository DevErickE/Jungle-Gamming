import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DataSource } from 'typeorm';
import { SubmitWagerUseCase } from '../../src/application/wagering/submit-wager.use-case.ts';
import { Metrics } from '../../src/infrastructure/metrics/metrics.ts';
import { OutboxPublisher, type EventSender } from '../../src/infrastructure/messaging/outbox-publisher.ts';
import { createOrm } from '../../src/infrastructure/persistence/orm.ts';
import { TEST_DATABASE_URL, openWallet, resetTestDatabase } from '../helpers/database.ts';
import pg from 'pg';

let orm: DataSource;
let client: pg.Client;

beforeAll(async () => {
  await resetTestDatabase();
  orm = await createOrm(TEST_DATABASE_URL);
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await orm?.destroy();
});

function bet(walletId: string, playerId: string, ext: string, amount: string) {
  return {
    idempotencyKey: `provider-a:${ext}`,
    providerId: 'provider-a',
    externalTransactionId: ext,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'g',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

describe('métricas de processamento', () => {
  test('contam transações por status, duplicatas, erros e tempo de lock', async () => {
    const metrics = new Metrics();
    const useCase = new SubmitWagerUseCase(orm, {}, metrics);
    const wallet = await openWallet(client, { initialMinor: 10000 });

    await useCase.execute(bet(wallet.id, wallet.playerId, 'm-ok', '25.00'));
    await useCase.execute(bet(wallet.id, wallet.playerId, 'm-ok', '25.00')); // repetição
    await useCase.execute(bet(wallet.id, wallet.playerId, 'm-big', '500.00')); // rejeitada

    expect(metrics.value('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' })).toBe(1);
    expect(metrics.value('wager_transactions_total', { kind: 'BET', status: 'REJECTED' })).toBe(1);
    expect(metrics.value('wager_duplicates_detected_total', { kind: 'BET' })).toBe(1);
    expect(metrics.observations('wallet_lock_wait_seconds')).toBeGreaterThanOrEqual(3);
    expect(metrics.observations('wager_processing_seconds', { kind: 'BET' })).toBe(3);

    await expect(useCase.execute(bet('00000000-0000-7000-8000-000000000000', wallet.playerId, 'm-x', '1.00'))).rejects.toThrow();
    expect(metrics.value('wager_errors_total', { code: 'WALLET_NOT_FOUND' })).toBe(1);
  });

  test('o publicador da outbox conta eventos publicados e mede o lag', async () => {
    const metrics = new Metrics();
    const useCase = new SubmitWagerUseCase(orm);
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await client.query('UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL');
    await useCase.execute(bet(wallet.id, wallet.playerId, 'm-outbox', '1.00'));

    const sender: EventSender = { send: async () => undefined };
    const publisher = new OutboxPublisher(orm, sender, 50, metrics);
    const published = await publisher.publishDue(new Date(Date.now() + 1000));

    expect(published).toBe(2);
    expect(metrics.value('outbox_events_published_total')).toBe(2);
    expect(metrics.value('outbox_lag_seconds')).toBe(0);
    expect(metrics.render()).toContain('# TYPE outbox_lag_seconds gauge');
  });
});
