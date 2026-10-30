import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Guarda o saldo observado no momento do processamento. Repetições idempotentes
 * devolvem esse valor, conforme a seção 7 da spec.
 */
export class Migration1793214000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wager_transactions
        ADD COLUMN balance_observed_minor bigint CHECK (balance_observed_minor >= 0)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE wager_transactions DROP COLUMN IF EXISTS balance_observed_minor');
  }
}
