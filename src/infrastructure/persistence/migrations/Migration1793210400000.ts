import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema inicial do serviço de carteiras e transações.
 *
 * Decisões (detalhadas em ARCHITECTURE.md):
 * - Valores monetários em bigint (unidades menores, centavos). Nunca float.
 * - Invariantes críticas no banco: saldo não negativo, unicidade de idempotência,
 *   unicidade de lançamento por (transação, wallet), ledger append-only.
 * - Chaves compostas garantem que uma transação só referencia wallet, jogador e moeda corretos.
 *
 * O nome da classe termina com o timestamp de 13 dígitos (ms), que o TypeORM usa para ordenar.
 */
export class Migration1793210400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_player_currency_unique UNIQUE (id, player_id, currency),
        CONSTRAINT wallets_id_currency_unique UNIQUE (id, currency)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id varchar(64) NOT NULL,
        external_transaction_id varchar(128) NOT NULL,
        idempotency_key varchar(255) NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL,
        round_id varchar(128) NOT NULL,
        game_id varchar(128) NOT NULL,
        kind varchar(16) NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
        reference_external_transaction_id varchar(128),
        reference_transaction_id uuid,
        status varchar(24) NOT NULL CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code varchar(64),
        reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_check_at timestamptz,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT wager_tx_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_id_wallet_unique UNIQUE (id, wallet_id),
        CONSTRAINT wager_tx_wallet_fk FOREIGN KEY (wallet_id, player_id, currency)
          REFERENCES wallets (id, player_id, currency),
        CONSTRAINT wager_tx_reference_fk FOREIGN KEY (reference_transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT wager_tx_reference_required CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_tx_processed_has_time CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
        CONSTRAINT wager_tx_failure_code_iff_rejected_or_failed CHECK (
          (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT wager_tx_reference_resolved_only CHECK (
          reference_transaction_id IS NULL OR status <> 'PENDING_REFERENCE'
        )
      )
    `);

    // Uma referência só pode ser revertida uma vez por tipo de operação (REFUND ou ROLLBACK).
    // Transações rejeitadas ou falhas não ocupam o índice.
    await queryRunner.query(`
      CREATE UNIQUE INDEX wager_tx_one_reversal_per_kind
        ON wager_transactions (reference_transaction_id, kind)
        WHERE reference_transaction_id IS NOT NULL AND status IN ('PENDING', 'PROCESSED')
    `);

    await queryRunner.query(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE'
    `);

    await queryRunner.query(`
      CREATE INDEX wager_tx_provider_reference_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE reference_external_transaction_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        wallet_version integer NOT NULL CHECK (wallet_version >= 1),
        direction varchar(8) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        currency char(3) NOT NULL,
        amount_minor bigint NOT NULL CHECK (amount_minor > 0),
        balance_before_minor bigint NOT NULL CHECK (balance_before_minor >= 0),
        balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after_minor = balance_before_minor + amount_minor)
          OR (direction = 'DEBIT' AND balance_after_minor = balance_before_minor - amount_minor)
        ),
        CONSTRAINT ledger_one_entry_per_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_wallet_version_unique UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT ledger_wallet_fk FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency)
      )
    `);

    // Ledger append-only: UPDATE, DELETE e TRUNCATE são rejeitados pelo banco.
    await queryRunner.query(`
      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only'
          USING ERRCODE = 'restrict_violation';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER wallet_ledger_entries_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation()
    `);

    // Inbox: deduplicação persistente de mensagens recebidas da fila.
    await queryRunner.query(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(64) NOT NULL,
        message_id varchar(128) NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);

    // Outbox: eventos gravados na mesma transação do negócio e publicados depois.
    await queryRunner.query(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type varchar(128) NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE INDEX outbox_pending_idx
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS outbox_messages');
    await queryRunner.query('DROP TABLE IF EXISTS inbox_messages');
    await queryRunner.query('DROP TABLE IF EXISTS wallet_ledger_entries');
    await queryRunner.query('DROP FUNCTION IF EXISTS reject_ledger_mutation()');
    await queryRunner.query('DROP TABLE IF EXISTS wager_transactions');
    await queryRunner.query('DROP TABLE IF EXISTS wallets');
  }
}
