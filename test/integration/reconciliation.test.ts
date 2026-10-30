import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { AppModule } from '../../src/app.module.ts';
import { TEST_DATABASE_URL, resetTestDatabase } from '../helpers/database.ts';

let app: INestApplication;
let base: string;
let client: pg.Client;

beforeAll(async () => {
  await resetTestDatabase();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.PENDING_REFERENCE_WORKER = 'disabled';
  process.env.MESSAGING_WORKERS = 'disabled';
  process.env.AWS_ENDPOINT_URL ??= 'http://127.0.0.1:4566';
  process.env.AWS_REGION ??= 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await app?.close();
});

// Corpo JSON ou texto (o /metrics devolve texto). Tipado como any para os asserts do teste.
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text };
}

async function createWalletWithBets(): Promise<string> {
  const playerId = crypto.randomUUID();
  const wallet = (await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  })).body as { id: string };
  const bet = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `provider-a:rec-${wallet.id}` },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: `rec-${wallet.id}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    }),
  });
  expect(bet.status).toBe(200);
  return wallet.id;
}

describe('POST /wallets/:walletId/reconciliation', () => {
  test('wallet consistente: consistent true e diferença zero', async () => {
    const walletId = await createWalletWithBets();

    const res = await call('POST', `/wallets/${walletId}/reconciliation`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência: sinalizada na resposta, contada em métrica e não corrigida', async () => {
    const walletId = await createWalletWithBets();
    // Simula corrupção direta do saldo (o ledger é imutável, o saldo não é protegido por trigger).
    await client.query('UPDATE wallets SET balance_minor = balance_minor + 500 WHERE id = $1', [walletId]);

    const res = await call('POST', `/wallets/${walletId}/reconciliation`);

    expect(res.status).toBe(200);
    expect(res.body.consistent).toBe(false);
    expect(res.body.storedBalance).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(res.body.calculatedBalance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(res.body.difference).toEqual({ amount: '5.00', currency: 'BRL' });

    // Não corrige em silêncio: o saldo continua divergente depois da reconciliação.
    const after = await call('GET', `/wallets/${walletId}`);
    expect(after.body.balance).toEqual({ amount: '80.00', currency: 'BRL' });

    const metrics = await call('GET', '/metrics');
    expect(String(metrics.body)).toMatch(/wallet_reconciliation_divergences_total\s+[1-9]\d*/);
  });

  test('divergência negativa aparece com sinal na diferença', async () => {
    const walletId = await createWalletWithBets();
    await client.query('UPDATE wallets SET balance_minor = balance_minor - 1234 WHERE id = $1', [walletId]);

    const res = await call('POST', `/wallets/${walletId}/reconciliation`);

    expect(res.body.consistent).toBe(false);
    expect(res.body.difference).toEqual({ amount: '-12.34', currency: 'BRL' });
  });

  test('wallet inexistente é 404 e UUID malformado é 400', async () => {
    expect((await call('POST', `/wallets/${crypto.randomUUID()}/reconciliation`)).status).toBe(404);
    expect((await call('POST', '/wallets/abc/reconciliation')).status).toBe(400);
  });
});
