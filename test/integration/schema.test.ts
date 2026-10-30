import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { runMigrations } from '../../src/infrastructure/persistence/migrator.ts';

/** Banco real de teste. Configure com TEST_DATABASE_URL (ver .env.example). */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wallet:wallet@127.0.0.1:5432/wallet_test';

const HASH = 'a'.repeat(64);
const AT = '2026-07-29T15:00:00.000Z';

// SQLSTATE esperados
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

let client: pg.Client;

beforeAll(async () => {
  await ensureDatabaseExists(DATABASE_URL);
  await resetSchema();
  await runMigrations(DATABASE_URL, 'up');
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

async function resetSchema(): Promise<void> {
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  try {
    await admin.query('DROP SCHEMA public CASCADE');
    await admin.query('CREATE SCHEMA public');
  } finally {
    await admin.end();
  }
}

async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const admin = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function expectSqlState(promise: Promise<unknown>, sqlState: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe(sqlState);
    return;
  }
  throw new Error(`esperava erro SQLSTATE ${sqlState}`);
}

async function insertWallet(
  overrides: { id?: string; playerId?: string; currency?: string; balance?: number } = {},
): Promise<{ id: string; playerId: string }> {
  const id = overrides.id ?? crypto.randomUUID();
  const playerId = overrides.playerId ?? crypto.randomUUID();
  await client.query(
    `INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5)`,
    [id, playerId, overrides.currency ?? 'BRL', overrides.balance ?? 0, AT],
  );
  return { id, playerId };
}

interface TxOverrides {
  id?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  wallet: { id: string; playerId: string };
  currency?: string;
  kind?: string;
  amount?: number;
  status?: string;
  failureCode?: string | null;
  referenceExternalId?: string | null;
  referenceTransactionId?: string | null;
  processedAt?: string | null;
}

async function insertTransaction(overrides: TxOverrides): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const providerId = overrides.providerId ?? 'provider-a';
  const externalId = overrides.externalId ?? `tx-${crypto.randomUUID()}`;
  const status = overrides.status ?? 'PROCESSED';
  await client.query(
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, currency, round_id, game_id, kind, amount_minor,
       reference_external_transaction_id, reference_transaction_id,
       status, failure_code, created_at, processed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'round-1','fortune-chimp',$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      providerId,
      externalId,
      overrides.idempotencyKey ?? `${providerId}:${externalId}`,
      HASH,
      overrides.wallet.id,
      overrides.wallet.playerId,
      overrides.currency ?? 'BRL',
      overrides.kind ?? 'BET',
      overrides.amount ?? 1000,
      overrides.referenceExternalId ?? null,
      overrides.referenceTransactionId ?? null,
      status,
      overrides.failureCode ?? null,
      AT,
      status === 'PROCESSED' ? (overrides.processedAt ?? AT) : (overrides.processedAt ?? null),
    ],
  );
  return id;
}

describe('wallets', () => {
  test('saldo negativo é rejeitado pelo banco', async () => {
    await expectSqlState(insertWallet({ balance: -1 }), CHECK_VIOLATION);
  });

  test('no máximo uma wallet por playerId + currency', async () => {
    const { playerId } = await insertWallet();
    await expectSqlState(insertWallet({ playerId }), UNIQUE_VIOLATION);
  });

  test('a mesma pessoa pode ter wallets em moedas diferentes', async () => {
    const { playerId } = await insertWallet({ currency: 'BRL' });
    await insertWallet({ playerId, currency: 'USD' });
  });

  test('moeda fora do formato ISO é rejeitada', async () => {
    await expectSqlState(insertWallet({ currency: 'br' }), CHECK_VIOLATION);
  });
});

describe('wager_transactions', () => {
  test('mesma chave de idempotência não pode existir duas vezes', async () => {
    const wallet = await insertWallet();
    await insertTransaction({ wallet, externalId: 'dup-1', idempotencyKey: 'key-1', status: 'PENDING' });
    await expectSqlState(
      insertTransaction({ wallet, externalId: 'dup-2', idempotencyKey: 'key-1', status: 'PENDING' }),
      UNIQUE_VIOLATION,
    );
  });

  test('mesmo providerId + externalTransactionId não pode existir duas vezes', async () => {
    const wallet = await insertWallet();
    await insertTransaction({ wallet, externalId: 'same', status: 'PENDING' });
    await expectSqlState(
      insertTransaction({ wallet, externalId: 'same', idempotencyKey: 'other-key', status: 'PENDING' }),
      UNIQUE_VIOLATION,
    );
  });

  test('REFUND e ROLLBACK exigem referenceExternalTransactionId', async () => {
    const wallet = await insertWallet();
    await expectSqlState(insertTransaction({ wallet, kind: 'REFUND' }), CHECK_VIOLATION);
    await expectSqlState(insertTransaction({ wallet, kind: 'ROLLBACK' }), CHECK_VIOLATION);
  });

  test('moeda da transação deve bater com a moeda da wallet', async () => {
    const wallet = await insertWallet({ currency: 'BRL' });
    await expectSqlState(insertTransaction({ wallet, currency: 'USD' }), FOREIGN_KEY_VIOLATION);
  });

  test('transação de outra wallet na referência é rejeitada', async () => {
    const walletA = await insertWallet();
    const walletB = await insertWallet();
    const betA = await insertTransaction({ wallet: walletA, kind: 'BET', amount: 500 });
    await expectSqlState(
      insertTransaction({
        wallet: walletB,
        kind: 'REFUND',
        referenceExternalId: 'bet',
        referenceTransactionId: betA,
      }),
      FOREIGN_KEY_VIOLATION,
    );
  });

  test('status REJECTED e FAILED exigem failure_code; os demais não', async () => {
    const wallet = await insertWallet();
    await expectSqlState(
      insertTransaction({ wallet, status: 'REJECTED', failureCode: null }),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      insertTransaction({ wallet, status: 'PROCESSED', failureCode: 'X' }),
      CHECK_VIOLATION,
    );
  });

  test('uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação', async () => {
    const wallet = await insertWallet();
    const win = await insertTransaction({ wallet, kind: 'WIN', amount: 300 });
    await insertTransaction({
      wallet,
      kind: 'ROLLBACK',
      referenceExternalId: 'win',
      referenceTransactionId: win,
    });
    await expectSqlState(
      insertTransaction({
        wallet,
        kind: 'ROLLBACK',
        referenceExternalId: 'win',
        referenceTransactionId: win,
      }),
      UNIQUE_VIOLATION,
    );
  });

  test('uma transação só pode ser revertida uma vez, mesmo por tipos diferentes', async () => {
    const wallet = await insertWallet();
    const bet = await insertTransaction({ wallet, kind: 'BET', amount: 200 });
    await insertTransaction({
      wallet,
      kind: 'REFUND',
      referenceExternalId: 'bet',
      referenceTransactionId: bet,
    });
    await expectSqlState(
      insertTransaction({
        wallet,
        kind: 'ROLLBACK',
        referenceExternalId: 'bet',
        referenceTransactionId: bet,
      }),
      UNIQUE_VIOLATION,
    );
  });

  test('transação rejeitada não ocupa a vaga de reversão', async () => {
    const wallet = await insertWallet();
    const bet = await insertTransaction({ wallet, kind: 'BET', amount: 200 });
    await insertTransaction({
      wallet,
      kind: 'REFUND',
      status: 'REJECTED',
      failureCode: 'REFERENCE_INVALID',
      referenceExternalId: 'bet',
      referenceTransactionId: bet,
    });
    await insertTransaction({
      wallet,
      kind: 'REFUND',
      referenceExternalId: 'bet',
      referenceTransactionId: bet,
    });
  });
});

describe('wallet_ledger_entries', () => {
  async function insertLedgerEntry(params: {
    wallet: { id: string; playerId: string };
    transactionId: string;
    version: number;
    direction: 'DEBIT' | 'CREDIT';
    amount: number;
    before: number;
    after: number;
    currency?: string;
  }): Promise<void> {
    await client.query(
      `INSERT INTO wallet_ledger_entries (
         id, wallet_id, transaction_id, wallet_version, direction, currency,
         amount_minor, balance_before_minor, balance_after_minor, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        crypto.randomUUID(),
        params.wallet.id,
        params.transactionId,
        params.version,
        params.direction,
        params.currency ?? 'BRL',
        params.amount,
        params.before,
        params.after,
        AT,
      ],
    );
  }

  test('aritmética inconsistente é rejeitada', async () => {
    const wallet = await insertWallet({ balance: 9000 });
    const tx = await insertTransaction({ wallet, kind: 'BET', amount: 1000 });
    await expectSqlState(
      insertLedgerEntry({
        wallet,
        transactionId: tx,
        version: 2,
        direction: 'DEBIT',
        amount: 1000,
        before: 10000,
        after: 10000,
      }),
      CHECK_VIOLATION,
    );
  });

  test('lançamento consistente é aceito e DEBIT subtrai', async () => {
    const wallet = await insertWallet({ balance: 10000 });
    const tx = await insertTransaction({ wallet, kind: 'BET', amount: 2500 });
    await insertLedgerEntry({
      wallet,
      transactionId: tx,
      version: 2,
      direction: 'DEBIT',
      amount: 2500,
      before: 10000,
      after: 7500,
    });
  });

  test('no máximo um lançamento por (transação, wallet)', async () => {
    const wallet = await insertWallet({ balance: 10000 });
    const tx = await insertTransaction({ wallet, kind: 'BET', amount: 100 });
    await insertLedgerEntry({
      wallet,
      transactionId: tx,
      version: 2,
      direction: 'DEBIT',
      amount: 100,
      before: 10000,
      after: 9900,
    });
    await expectSqlState(
      insertLedgerEntry({
        wallet,
        transactionId: tx,
        version: 3,
        direction: 'DEBIT',
        amount: 100,
        before: 9900,
        after: 9800,
      }),
      UNIQUE_VIOLATION,
    );
  });

  test('versão da wallet é única por wallet (sem dois lançamentos na mesma versão)', async () => {
    const wallet = await insertWallet({ balance: 10000 });
    const txA = await insertTransaction({ wallet, kind: 'BET', amount: 100 });
    const txB = await insertTransaction({ wallet, kind: 'BET', amount: 100 });
    await insertLedgerEntry({
      wallet,
      transactionId: txA,
      version: 2,
      direction: 'DEBIT',
      amount: 100,
      before: 10000,
      after: 9900,
    });
    await expectSqlState(
      insertLedgerEntry({
        wallet,
        transactionId: txB,
        version: 2,
        direction: 'DEBIT',
        amount: 100,
        before: 9900,
        after: 9800,
      }),
      UNIQUE_VIOLATION,
    );
  });

  test('ledger é append-only: UPDATE, DELETE e TRUNCATE são rejeitados', async () => {
    const wallet = await insertWallet({ balance: 500 });
    const tx = await insertTransaction({ wallet, kind: 'WIN', amount: 500 });
    await insertLedgerEntry({
      wallet,
      transactionId: tx,
      version: 2,
      direction: 'CREDIT',
      amount: 500,
      before: 0,
      after: 500,
    });

    await expectSqlState(
      client.query('UPDATE wallet_ledger_entries SET amount_minor = 1 WHERE wallet_id = $1', [wallet.id]),
      RESTRICT_VIOLATION,
    );
    await expectSqlState(
      client.query('DELETE FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id]),
      RESTRICT_VIOLATION,
    );
    await expectSqlState(client.query('TRUNCATE wallet_ledger_entries'), RESTRICT_VIOLATION);
  });
});

describe('inbox e outbox', () => {
  test('inbox deduplica por (consumer_name, message_id)', async () => {
    await client.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES ('wager-consumer', 'msg-1', $1, $2)`,
      [HASH, AT],
    );
    await expectSqlState(
      client.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES ('wager-consumer', 'msg-1', $1, $2)`,
        [HASH, AT],
      ),
      UNIQUE_VIOLATION,
    );
  });

  test('outbox aceita evento pendente e exige attempts não negativo', async () => {
    await client.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
       VALUES ($1, $2, 'WalletBalanceChanged', '{"data":{}}', $3, $3)`,
      [crypto.randomUUID(), crypto.randomUUID(), AT],
    );
    await expectSqlState(
      client.query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, attempts)
         VALUES ($1, $2, 'X', '{}', $3, $3, -1)`,
        [crypto.randomUUID(), crypto.randomUUID(), AT],
      ),
      CHECK_VIOLATION,
    );
  });
});

describe('migrações reversíveis', () => {
  test('down remove o schema e up recria', async () => {
    // Cada `down` reverte apenas a última migration aplicada: são três.
    await runMigrations(DATABASE_URL, 'down');
    await runMigrations(DATABASE_URL, 'down');
    await runMigrations(DATABASE_URL, 'down');
    const afterDown = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')`,
    );
    expect(afterDown.rowCount).toBe(0);

    await runMigrations(DATABASE_URL, 'up');
    const afterUp = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')`,
    );
    expect(afterUp.rowCount).toBe(5);
  });
});
