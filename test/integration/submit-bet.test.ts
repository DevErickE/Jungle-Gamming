import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DataSource } from 'typeorm';
import pg from 'pg';
import { SubmitWagerUseCase, type SubmitWagerInput } from '../../src/application/wagering/submit-wager.use-case.ts';
import { IdempotencyConflictError, WalletNotFoundError } from '../../src/application/errors.ts';
import { FailureCode } from '../../src/domain/wagering/failure-code.ts';
import { createOrm } from '../../src/infrastructure/persistence/orm.ts';
import {
  TEST_DATABASE_URL,
  assertLedgerMatchesBalance,
  openWallet,
  resetTestDatabase,
} from '../helpers/database.ts';

let orm: DataSource;
let useCase: SubmitWagerUseCase;
let client: pg.Client;

beforeAll(async () => {
  await resetTestDatabase();
  orm = await createOrm(TEST_DATABASE_URL);
  useCase = new SubmitWagerUseCase(orm);
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await orm?.destroy();
});

function bet(wallet: { id: string; playerId: string }, overrides: Partial<SubmitWagerInput> = {}): SubmitWagerInput {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${Bun.randomUUIDv7()}`;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
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

describe('BET: cenário obrigatório da spec', () => {
  test('saldo 100.00 e duas apostas de 80.00 em paralelo: uma processada, uma rejeitada', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });

    const results = await Promise.all([
      useCase.execute(bet(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
      useCase.execute(bet(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = results.find((r) => r.status === 'REJECTED');
    expect(rejected?.failureCode).toBe(FailureCode.InsufficientFunds);

    expect(await balanceOf(wallet.id)).toBe('2000');
    expect(await debitCount(wallet.id)).toBe(1);
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('repetir a mesma aposta depois do resultado não debita de novo', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const input = bet(wallet, { externalTransactionId: 'retry-me' });

    const first = await useCase.execute(input);
    const retry = await useCase.execute(input);

    expect(first.status).toBe('PROCESSED');
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.transactionId).toBe(first.transactionId);
    expect(retry.balance).toEqual(first.balance);
    expect(await balanceOf(wallet.id)).toBe('7500');
    expect(await debitCount(wallet.id)).toBe(1);
  });
});

describe('idempotência', () => {
  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const wallet = await openWallet(client, { initialMinor: 100000 });
    const input = bet(wallet, { externalTransactionId: 'same-bet-50x' });

    const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute(input)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('97500');
    expect(await debitCount(wallet.id)).toBe(1);
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('mesma chave com payload diferente é conflito, não replay', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(bet(wallet, { idempotencyKey: 'key-conflict', externalTransactionId: 'c-1' }));

    await expect(
      useCase.execute(
        bet(wallet, {
          idempotencyKey: 'key-conflict',
          externalTransactionId: 'c-1',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(wallet.id)).toBe('7500');
  });

  test('replay de rejeição devolve o saldo observado na época, não o atual', async () => {
    const wallet = await openWallet(client, { initialMinor: 1000 });
    const input = bet(wallet, { externalTransactionId: 'too-big', money: { amount: '50.00', currency: 'BRL' } });

    const rejected = await useCase.execute(input);
    await useCase.execute(bet(wallet, { money: { amount: '5.00', currency: 'BRL' } }));
    const replay = await useCase.execute(input);

    expect(rejected.status).toBe('REJECTED');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance).toEqual(rejected.balance);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});

describe('concorrência entre wallets e saldo', () => {
  test('wallets diferentes processadas em paralelo, cada uma com saldo correto', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => openWallet(client, { initialMinor: 10000 })),
    );

    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () => useCase.execute(bet(wallet, { money: { amount: '10.00', currency: 'BRL' } }))),
      ),
    );

    expect(results.every((r) => r.status === 'PROCESSED')).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('5000');
      await assertLedgerMatchesBalance(client, wallet.id);
    }
  });

  test('saldo nunca fica negativo com muitas apostas disputando a mesma wallet', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const results = await Promise.all(
      Array.from({ length: 30 }, () => useCase.execute(bet(wallet, { money: { amount: '5.00', currency: 'BRL' } }))),
    );

    const processed = results.filter((r) => r.status === 'PROCESSED').length;
    expect(processed).toBe(20);
    expect(await balanceOf(wallet.id)).toBe('0');
    expect(await debitCount(wallet.id)).toBe(20);
    await assertLedgerMatchesBalance(client, wallet.id);
  });
});

describe('validações', () => {
  test('wallet inexistente', async () => {
    await expect(
      useCase.execute({
        idempotencyKey: 'missing-wallet',
        providerId: 'provider-a',
        externalTransactionId: 'missing-wallet',
        playerId: Bun.randomUUIDv7(),
        walletId: Bun.randomUUIDv7(),
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('moeda diferente da wallet não é gravada', async () => {
    const wallet = await openWallet(client, { initialMinor: 1000 });
    await expect(
      useCase.execute(bet(wallet, { externalTransactionId: 'usd', money: { amount: '1.00', currency: 'USD' } })),
    ).rejects.toMatchObject({ code: 'CURRENCY_WALLET_MISMATCH' });

    const rows = await client.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1', ['usd']);
    expect(rows.rowCount).toBe(0);
  });

  test('tipos desconhecidos são recusados antes de tocar no banco', async () => {
    const wallet = await openWallet(client, { initialMinor: 1000 });
    await expect(useCase.execute(bet(wallet, { kind: 'FOO' }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_TRANSACTION_KIND',
    });
  });
});

describe('outbox na mesma transação', () => {
  test('cada aposta processada grava eventos de outbox', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const result = await useCase.execute(bet(wallet, { externalTransactionId: 'evt-1' }));

    const events = await client.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 OR aggregate_id = $2 ORDER BY event_type",
      [result.transactionId, wallet.id],
    );
    expect(events.rows.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });
});
