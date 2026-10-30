import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Uma transação só pode ser revertida uma vez, por REFUND ou ROLLBACK. Antes o índice
 * limitava por tipo, o que permitia REFUND e ROLLBACK da mesma BET e creditava duas vezes.
 */
export class Migration1793217600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS wager_tx_one_reversal_per_kind');
    await queryRunner.query(`
      CREATE UNIQUE INDEX wager_tx_one_reversal_per_target
        ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL
          AND kind IN ('REFUND', 'ROLLBACK')
          AND status IN ('PENDING', 'PROCESSED')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS wager_tx_one_reversal_per_target');
    await queryRunner.query(`
      CREATE UNIQUE INDEX wager_tx_one_reversal_per_kind
        ON wager_transactions (reference_transaction_id, kind)
        WHERE reference_transaction_id IS NOT NULL AND status IN ('PENDING', 'PROCESSED')
    `);
  }
}
