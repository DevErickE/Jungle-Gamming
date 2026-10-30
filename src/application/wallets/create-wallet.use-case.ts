import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../domain/money/money.ts';
import { canonicalJson } from '../../domain/wagering/payload-hash.ts';
import { Wallet } from '../../domain/wallet/wallet.ts';
import { minorUnitsOf } from '../../infrastructure/persistence/money-mapper.ts';
import type { Orm } from '../../infrastructure/persistence/orm.ts';
import { queryOne, runSql, type Em } from '../../infrastructure/persistence/sql.ts';
import { WalletAlreadyExistsError } from '../errors.ts';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletCreated {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Cria a wallet. Com saldo inicial positivo, grava também a transação interna OPENING
 * e o lançamento CREDIT correspondente, tudo na mesma transação de banco.
 */
export class CreateWalletUseCase {
  constructor(private readonly orm: Orm) {}

  async execute(input: CreateWalletInput): Promise<WalletCreated> {
    const initial = Money.from(input.initialBalance);
    const now = new Date();
    const walletId = Bun.randomUUIDv7();
    const openingTransactionId = Bun.randomUUIDv7();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance: initial,
      openingEntryId: Bun.randomUUIDv7(),
      openingTransactionId,
      at: now,
    });

    try {
      await this.orm.transaction(async (tx) => {
        const existing = await queryOne<{ id: string }>(
          tx,
          'SELECT id FROM wallets WHERE player_id = ? AND currency = ?',
          [input.playerId, initial.currency],
        );
        if (existing) {
          throw new WalletAlreadyExistsError(input.playerId, initial.currency);
        }

        await insertWallet(tx, wallet, now);

        if (openingEntry) {
          const payloadHash = createHash('sha256')
            .update(canonicalJson({ kind: 'OPENING', walletId, playerId: input.playerId, money: initial.toJSON() }))
            .digest('hex');
          const minor = minorUnitsOf(initial).toString();
          await runSql(
            tx,
            `INSERT INTO wager_transactions (
               id, provider_id, external_transaction_id, idempotency_key, payload_hash,
               wallet_id, player_id, currency, round_id, game_id, kind, amount_minor,
               status, created_at, processed_at, balance_observed_minor
             ) VALUES (?, 'internal', ?, ?, ?, ?, ?, ?, 'opening', 'opening', 'OPENING', ?, 'PROCESSED', ?, ?, ?)`,
            [
              openingTransactionId,
              `opening:${walletId}`,
              `opening:${walletId}`,
              payloadHash,
              walletId,
              input.playerId,
              initial.currency,
              minor,
              now,
              now,
              minor,
            ],
          );
          await runSql(
            tx,
            `INSERT INTO wallet_ledger_entries (
               id, wallet_id, transaction_id, wallet_version, direction, currency,
               amount_minor, balance_before_minor, balance_after_minor, created_at
             ) VALUES (?, ?, ?, 1, 'CREDIT', ?, ?, 0, ?, ?)`,
            [openingEntry.id, walletId, openingTransactionId, initial.currency, minor, minor, now],
          );
        }
      });
    } catch (error) {
      // Corrida entre duas criações: a unique constraint do banco vence e vira conflito.
      if ((error as { code?: string }).code === '23505') {
        throw new WalletAlreadyExistsError(input.playerId, initial.currency);
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}

async function insertWallet(tx: Em, wallet: Wallet, now: Date): Promise<void> {
  await runSql(
    tx,
    `INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [wallet.id, wallet.playerId, wallet.currency, minorUnitsOf(wallet.balance).toString(), wallet.version, now, now],
  );
}
