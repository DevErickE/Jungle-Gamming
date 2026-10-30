import { createOrm } from './orm.ts';

/**
 * Executa migrations sobre o banco indicado. `up` aplica as pendentes; `down` reverte
 * a última aplicada. Cada migration roda na própria transação. Cada chamada abre e fecha
 * a própria conexão.
 */
export async function runMigrations(url: string, direction: 'up' | 'down'): Promise<void> {
  const orm = await createOrm(url);
  try {
    if (direction === 'up') {
      await orm.runMigrations({ transaction: 'each' });
    } else {
      await orm.undoLastMigration({ transaction: 'each' });
    }
  } finally {
    await orm.destroy();
  }
}
