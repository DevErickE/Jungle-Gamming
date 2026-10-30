/**
 * Aplica ou reverte migrations no banco indicado por DATABASE_URL.
 *
 *   bun scripts/migrate.ts up
 *   bun scripts/migrate.ts down
 */
import { runMigrations } from '../src/infrastructure/persistence/migrator.ts';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('uso: bun scripts/migrate.ts up|down');
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? 'postgres://wallet:wallet@127.0.0.1:5432/wallet';
await runMigrations(url, direction);
console.log(`migrations ${direction}: concluído`);
