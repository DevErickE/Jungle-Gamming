import type { EntityManager } from 'typeorm';

/** Gerenciador de entidades usado pelo SQL explícito: o da conexão ou o de uma transação. */
export type Em = EntityManager;

/**
 * Troca os `?` por `$1, $2, ...`, que é o formato dos parâmetros do driver `pg`.
 * Assim o SQL continua escrito com `?`, como antes.
 */
function numbered(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/** Primeira linha do resultado, ou null. */
export async function queryOne<T>(em: Em, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await queryAll<T>(em, sql, params);
  return rows[0] ?? null;
}

export async function queryAll<T>(em: Em, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await em.query(numbered(sql), params)) as T[];
}

/**
 * Executa uma instrução que altera linhas e devolve quantas foram afetadas. Fora de uma
 * transação, abre e libera uma conexão própria; dentro de uma transação, usa a mesma conexão.
 */
export async function runSql(em: Em, sql: string, params: unknown[] = []): Promise<number> {
  const runner = em.queryRunner ?? em.connection.createQueryRunner();
  try {
    const result = await runner.query(numbered(sql), params, true);
    return result.affected ?? 0;
  } finally {
    if (!em.queryRunner) {
      await runner.release();
    }
  }
}
