import pg from 'pg';
import { runMigrations } from '../../src/infrastructure/persistence/migrator.ts';

/** Banco real de teste. Configure com TEST_DATABASE_URL. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wallet:wallet@127.0.0.1:5432/wallet_test';

const OPENING_HASH = '0'.repeat(64);

/** Recria o banco de teste do zero e aplica as migrations. */
export async function resetTestDatabase(url: string = TEST_DATABASE_URL): Promise<void> {
  const dbName = new URL(url).pathname.slice(1);
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

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  await runMigrations(url, 'up');
}

/**
 * Cria uma wallet com saldo inicial, do mesmo modo que o caso de uso de abertura:
 * wallet + transação OPENING interna + lançamento CREDIT, tudo junto.
 */
export async function openWallet(
  client: pg.Client,
  params: { playerId?: string; currency?: string; initialMinor?: number } = {},
): Promise<{ id: string; playerId: string }> {
  const id = Bun.randomUUIDv7();
  const playerId = params.playerId ?? Bun.randomUUIDv7();
  const currency = params.currency ?? 'BRL';
  const initial = params.initialMinor ?? 0;
  const now = new Date();

  await client.query(
    `INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5)`,
    [id, playerId, currency, initial, now],
  );

  if (initial > 0) {
    const txId = Bun.randomUUIDv7();
    await client.query(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, currency, round_id, game_id, kind, amount_minor,
         status, created_at, processed_at, balance_observed_minor
       ) VALUES ($1, 'internal', $2, $2, $3, $4, $5, $6, 'opening', 'opening', 'OPENING', $7,
                 'PROCESSED', $8, $8, $7)`,
      [txId, `opening:${id}`, OPENING_HASH, id, playerId, currency, initial, now],
    );
    await client.query(
      `INSERT INTO wallet_ledger_entries (
         id, wallet_id, transaction_id, wallet_version, direction, currency,
         amount_minor, balance_before_minor, balance_after_minor, created_at
       ) VALUES ($1, $2, $3, 1, 'CREDIT', $4, $5, 0, $5, $6)`,
      [Bun.randomUUIDv7(), id, txId, currency, initial, now],
    );
  }

  return { id, playerId };
}

/** Invariante final: saldo materializado igual ao reconstruído pelo ledger. */
export async function assertLedgerMatchesBalance(client: pg.Client, walletId: string): Promise<void> {
  const result = await client.query<{ stored: string; calculated: string | null }>(
    `SELECT w.balance_minor AS stored,
            COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END), 0) AS calculated
       FROM wallets w
       LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
      WHERE w.id = $1
      GROUP BY w.balance_minor`,
    [walletId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`wallet ${walletId} not found`);
  }
  if (BigInt(row.stored) !== BigInt(row.calculated ?? 0)) {
    throw new Error(`ledger mismatch for ${walletId}: stored ${row.stored}, calculated ${row.calculated}`);
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
