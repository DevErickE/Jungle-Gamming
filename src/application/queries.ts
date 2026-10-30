import type { MoneyProps } from '../domain/money/money.ts';
import type { Orm } from '../infrastructure/persistence/orm.ts';
import { moneyFromMinorUnits } from '../infrastructure/persistence/money-mapper.ts';
import { queryAll, queryOne } from '../infrastructure/persistence/sql.ts';
import { InvalidRequestError, TransactionNotFoundError, WalletNotFoundError } from './errors.ts';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerPage {
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
  failureCode: string | null;
  money: MoneyProps;
  balance: MoneyProps | null;
  createdAt: Date;
  processedAt: Date | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_INTEGER = 2_147_483_647;

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_minor: string;
  version: number;
}

interface LedgerRow {
  id: string;
  transaction_id: string;
  direction: 'DEBIT' | 'CREDIT';
  currency: string;
  amount_minor: string;
  balance_before_minor: string;
  balance_after_minor: string;
  wallet_version: number;
  created_at: Date;
}

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  wallet_id: string;
  kind: string;
  status: string;
  failure_code: string | null;
  currency: string;
  amount_minor: string;
  balance_observed_minor: string | null;
  created_at: Date;
  processed_at: Date | null;
}

const WALLET_COLUMNS = 'id, player_id, currency, balance_minor, version';
const TRANSACTION_COLUMNS = `id, provider_id, external_transaction_id, wallet_id, kind, status, failure_code,
  currency, amount_minor, balance_observed_minor, created_at, processed_at`;

/** Consultas de leitura. Não alteram estado e não tomam locks. */
export class ReadModel {
  constructor(private readonly orm: Orm) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const row = await queryOne<WalletRow>(
      this.orm.manager,
      `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`,
      [walletId],
    );
    if (!row) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(row);
  }

  /**
   * Ledger paginado do mais recente para o mais antigo. O cursor é opaco e carrega a
   * versão da wallet do último item, então a paginação continua estável mesmo com novos lançamentos.
   */
  async listLedger(walletId: string, params: { cursor?: string; limit?: number }): Promise<LedgerPage> {
    const em = this.orm.manager;
    const wallet = await queryOne<WalletRow>(em, `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, [walletId]);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const limit = normalizeLimit(params.limit);
    // wallet_version é integer: o maior valor possível é 2^31 - 1, e não Number.MAX_SAFE_INTEGER.
    const beforeVersion = params.cursor !== undefined ? decodeCursor(params.cursor) : MAX_INTEGER;
    const rows = await queryAll<LedgerRow>(
      em,
      `SELECT id, transaction_id, direction, currency, amount_minor,
              balance_before_minor, balance_after_minor, wallet_version, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND wallet_version < ?
        ORDER BY wallet_version DESC
        LIMIT ?`,
      [walletId, beforeVersion, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      entries: page.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: moneyFromMinorUnits(row.amount_minor, row.currency).toJSON(),
        balanceBefore: moneyFromMinorUnits(row.balance_before_minor, row.currency).toJSON(),
        balanceAfter: moneyFromMinorUnits(row.balance_after_minor, row.currency).toJSON(),
        walletVersion: row.wallet_version,
        createdAt: row.created_at,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.wallet_version) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const row = await queryOne<TransactionRow>(
      this.orm.manager,
      `SELECT ${TRANSACTION_COLUMNS} FROM wager_transactions WHERE id = ?`,
      [transactionId],
    );
    if (!row) {
      throw new TransactionNotFoundError(transactionId);
    }
    return toTransactionView(row);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const row = await queryOne<TransactionRow>(
      this.orm.manager,
      `SELECT ${TRANSACTION_COLUMNS} FROM wager_transactions
        WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    if (!row) {
      throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    }
    return toTransactionView(row);
  }
}

function toWalletView(row: WalletRow): WalletView {
  return {
    id: row.id,
    playerId: row.player_id,
    balance: moneyFromMinorUnits(row.balance_minor, row.currency).toJSON(),
    version: row.version,
  };
}

function toTransactionView(row: TransactionRow): TransactionView {
  return {
    transactionId: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    walletId: row.wallet_id,
    kind: row.kind,
    status: row.status,
    failureCode: row.failure_code,
    money: moneyFromMinorUnits(row.amount_minor, row.currency).toJSON(),
    balance:
      row.balance_observed_minor === null
        ? null
        : moneyFromMinorUnits(row.balance_observed_minor, row.currency).toJSON(),
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidRequestError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v === 'number' && Number.isInteger(parsed.v)) {
      return parsed.v;
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidRequestError('invalid cursor');
}
