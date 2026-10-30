import { beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { TEST_DATABASE_URL, assertLedgerMatchesBalance, openWallet, resetTestDatabase } from '../helpers/database.ts';

const WORKER = fileURLToPath(new URL('../fixtures/submit-bets-worker.ts', import.meta.url));

let client: pg.Client;

beforeAll(async () => {
  await resetTestDatabase();
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

/** Executa um processo filho que envia `count` apostas de `amountMinor` centavos. */
async function runWorker(
  wallet: { id: string; playerId: string },
  workerId: number,
  count: number,
  amountMinor: number,
): Promise<string[]> {
  const proc = Bun.spawn(
    [process.execPath, WORKER, wallet.id, wallet.playerId, String(workerId), String(count), String(amountMinor)],
    {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`worker ${workerId} falhou (${exitCode}): ${stderr}`);
  }
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '[]');
}

describe('múltiplos processos sobre a mesma wallet', () => {
  test('3 processos disputando saldo de 100.00 com apostas de 5.00: exatamente 20 processadas', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });

    const outcomes = await Promise.all([
      runWorker(wallet, 1, 10, 500),
      runWorker(wallet, 2, 10, 500),
      runWorker(wallet, 3, 10, 500),
    ]);

    const statuses = outcomes.flat();
    expect(statuses).toHaveLength(30);
    expect(statuses.filter((s) => s === 'PROCESSED')).toHaveLength(20);
    expect(statuses.filter((s) => s === 'REJECTED')).toHaveLength(10);

    const balance = await client.query<{ balance_minor: string }>(
      'SELECT balance_minor FROM wallets WHERE id = $1',
      [wallet.id],
    );
    expect(balance.rows[0]?.balance_minor).toBe('0');
    await assertLedgerMatchesBalance(client, wallet.id);
  }, 30_000);
});
