import { DataSource } from 'typeorm';
import { MIGRATIONS } from './migrations/index.ts';

/** Conexão compartilhada pela aplicação e pelos workers, com o TypeORM. */
export type Orm = DataSource;

/**
 * Abre a conexão com o PostgreSQL. As entidades não são mapeadas: o acesso crítico usa SQL
 * explícito dentro de `orm.transaction`, para controlar locks e constraints. A tabela de
 * migrations é `schema_migrations`.
 */
export async function createOrm(url: string): Promise<Orm> {
  return new DataSource({
    type: 'postgres',
    url,
    entities: [],
    migrations: MIGRATIONS,
    migrationsTableName: 'schema_migrations',
    synchronize: false,
    logging: false,
  }).initialize();
}
