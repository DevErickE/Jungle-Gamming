import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { AppModule } from '../../src/app.module.ts';
import { TEST_DATABASE_URL, assertLedgerMatchesBalance, resetTestDatabase } from '../helpers/database.ts';

let app: INestApplication;
let base: string;
let client: pg.Client;

beforeAll(async () => {
  await resetTestDatabase();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.PENDING_REFERENCE_WORKER = 'disabled';
  process.env.MESSAGING_WORKERS = 'disabled';
  // LocalStack para o check de SQS do /health/ready.
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

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as Record<string, any>;
  return { status: res.status, body: json };
}

const post = (path: string, body: unknown, headers?: Record<string, string>) => call('POST', path, body, headers);
const get = (path: string) => call('GET', path);

async function createWallet(amount = '1000.00', playerId = Bun.randomUUIDv7()) {
  const res = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

function betBody(walletId: string, playerId: string, externalTransactionId: string, amount = '25.00') {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

const keyFor = (externalTransactionId: string) => ({ 'Idempotency-Key': `provider-a:${externalTransactionId}` });

describe('POST /wallets e GET /wallets/:id', () => {
  test('cria wallet com saldo inicial e version 1', async () => {
    const wallet = await createWallet('1000.00');
    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
  });

  test('wallet duplicada para o mesmo jogador e moeda é conflito (409)', async () => {
    const playerId = Bun.randomUUIDv7();
    await createWallet('10.00', playerId);
    const res = await post('/wallets', { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('saldo inicial inválido é 400 com código do domínio', async () => {
    const res = await post('/wallets', {
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '1e3', currency: 'BRL' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MONEY_INVALID_AMOUNT');
  });

  test('playerId malformado é 400', async () => {
    const res = await post('/wallets', { playerId: 'nao-e-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(res.status).toBe(400);
  });

  test('GET wallet existente retorna 200', async () => {
    const wallet = await createWallet('50.00');
    const res = await get(`/wallets/${wallet.id}`);
    expect(res.status).toBe(200);
    expect(res.body.balance).toEqual({ amount: '50.00', currency: 'BRL' });
  });

  test('GET wallet inexistente é 404; UUID malformado é 400', async () => {
    expect((await get(`/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await get('/wallets/abc')).status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET aprovada retorna 200 PROCESSED e atualiza o saldo', async () => {
    const wallet = await createWallet('100.00');
    const res = await post('/wagering/transactions', betBody(wallet.id, wallet.playerId, 'bet-ok'), keyFor('bet-ok'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
    expect(res.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(res.body.idempotentReplay).toBe(false);
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('repetir a mesma requisição retorna 200 com idempotentReplay true', async () => {
    const wallet = await createWallet('100.00');
    const body = betBody(wallet.id, wallet.playerId, 'bet-replay');
    const first = await post('/wagering/transactions', body, keyFor('bet-replay'));
    const second = await post('/wagering/transactions', body, keyFor('bet-replay'));

    expect(second.status).toBe(200);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.transactionId).toBe(first.body.transactionId);
  });

  test('saldo insuficiente é 422 com failureCode no corpo', async () => {
    const wallet = await createWallet('10.00');
    const res = await post(
      '/wagering/transactions',
      betBody(wallet.id, wallet.playerId, 'bet-poor', '25.00'),
      keyFor('bet-poor'),
    );

    expect(res.status).toBe(422);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.failureCode).toBe('WALLET_INSUFFICIENT_FUNDS');
    expect(res.body.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('Idempotency-Key ausente é 400', async () => {
    const wallet = await createWallet('100.00');
    const res = await post('/wagering/transactions', betBody(wallet.id, wallet.playerId, 'no-key'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  test('mesma chave com payload diferente é 409', async () => {
    const wallet = await createWallet('100.00');
    await post('/wagering/transactions', betBody(wallet.id, wallet.playerId, 'conflict'), keyFor('conflict'));
    const res = await post(
      '/wagering/transactions',
      betBody(wallet.id, wallet.playerId, 'conflict', '30.00'),
      keyFor('conflict'),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('wallet inexistente é 404', async () => {
    const res = await post(
      '/wagering/transactions',
      betBody(Bun.randomUUIDv7(), Bun.randomUUIDv7(), 'missing'),
      keyFor('missing'),
    );
    expect(res.status).toBe(404);
  });

  test('jogador ou moeda divergentes da wallet são 422', async () => {
    const wallet = await createWallet('100.00');
    const wrongPlayer = await post(
      '/wagering/transactions',
      betBody(wallet.id, Bun.randomUUIDv7(), 'wrong-player'),
      keyFor('wrong-player'),
    );
    expect(wrongPlayer.status).toBe(422);

    const wrongCurrency = await post(
      '/wagering/transactions',
      { ...betBody(wallet.id, wallet.playerId, 'wrong-currency'), money: { amount: '1.00', currency: 'USD' } },
      keyFor('wrong-currency'),
    );
    expect(wrongCurrency.status).toBe(422);
    expect(wrongCurrency.body.error.code).toBe('CURRENCY_WALLET_MISMATCH');
  });

  test('kinds desconhecidos são 422', async () => {
    const wallet = await createWallet('100.00');
    const res = await post(
      '/wagering/transactions',
      { ...betBody(wallet.id, wallet.playerId, 'unknown-kind'), kind: 'FOO' },
      keyFor('unknown-kind'),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNSUPPORTED_TRANSACTION_KIND');
  });

  test('50 requisições idênticas em paralelo geram um único débito', async () => {
    const wallet = await createWallet('1000.00');
    const body = betBody(wallet.id, wallet.playerId, 'burst-50');
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => post('/wagering/transactions', body, keyFor('burst-50'))),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    const balance = await get(`/wallets/${wallet.id}`);
    expect(balance.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    await assertLedgerMatchesBalance(client, wallet.id);
  });
});

describe('consultas de transação', () => {
  test('GET por id e por provedor + externalTransactionId', async () => {
    const wallet = await createWallet('100.00');
    const created = await post('/wagering/transactions', betBody(wallet.id, wallet.playerId, 'lookup'), keyFor('lookup'));

    const byId = await get(`/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.status).toBe('PROCESSED');
    expect(byId.body.money).toEqual({ amount: '25.00', currency: 'BRL' });

    const byExternal = await get('/providers/provider-a/wagering/transactions/lookup');
    expect(byExternal.status).toBe(200);
    expect(byExternal.body.transactionId).toBe(created.body.transactionId);
  });

  test('transação inexistente é 404', async () => {
    expect((await get(`/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await get('/providers/provider-a/wagering/transactions/nao-existe')).status).toBe(404);
  });
});

describe('GET /wallets/:id/ledger com cursor', () => {
  test('percorre todos os lançamentos em páginas de 2, do mais recente ao mais antigo', async () => {
    const wallet = await createWallet('100.00');
    for (let i = 1; i <= 4; i++) {
      await post('/wagering/transactions', betBody(wallet.id, wallet.playerId, `page-${i}`, '1.00'), keyFor(`page-${i}`));
    }

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const page = await get(`/wallets/${wallet.id}/ledger${query}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.entries.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = page.body.nextCursor;
    } while (cursor);

    // 1 abertura + 4 apostas = versões 1 a 5, sem repetição nem lacuna
    expect(seen).toEqual([5, 4, 3, 2, 1]);
  });

  test('cursor inválido é 400 e limit fora do intervalo é 400', async () => {
    const wallet = await createWallet('10.00');
    expect((await get(`/wallets/${wallet.id}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await get(`/wallets/${wallet.id}/ledger?limit=500`)).status).toBe(400);
  });
});

describe('health', () => {
  test('liveness responde sem autenticação', async () => {
    expect((await get('/health/live')).status).toBe(200);
  });

  test('readiness confirma PostgreSQL e SQS alcançáveis', async () => {
    const res = await get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: 'up', sqs: 'up' });
  });
});
