/**
 * Apaga todo o conteúdo de um schema PostgreSQL e, opcionalmente, aplica as migrations de novo.
 * Serve para qualquer banco: só muda a URL e o schema.
 *
 *   bun scripts/db-reset.ts --yes
 *
 * O `--yes` é obrigatório, porque a operação apaga todos os dados do schema.
 */
import pg from 'pg';
import { runMigrations } from '../src/infrastructure/persistence/migrator.ts';

/* ===== PARTES VARIÁVEIS: ajuste para cada banco ===================================== */
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wallet:wallet@127.0.0.1:5432/wallet';
const SCHEMA = process.env.DB_SCHEMA ?? 'public';
const RUN_MIGRATIONS_AFTER = true;
/* ==================================================================================== */

if (!process.argv.includes('--yes')) {
  console.error('Operação destrutiva: apaga todos os dados do schema. Rode com --yes para confirmar.');
  process.exit(1);
}

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(SCHEMA)) {
  console.error(`Nome de schema inválido: ${SCHEMA}`);
  process.exit(1);
}

const target = new URL(DATABASE_URL);
console.log(`Resetando schema "${SCHEMA}" em ${target.host}${target.pathname}`);

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${SCHEMA}"`);
} finally {
  await client.end();
}
console.log('Schema recriado.');

if (RUN_MIGRATIONS_AFTER) {
  await runMigrations(DATABASE_URL, 'up');
  console.log('Migrations aplicadas.');
}
