import { InboxMessage } from '../../domain/messaging/inbox-message.ts';
import type { EventContext, IntegrationEvent } from '../../domain/messaging/integration-event.ts';
import { OutboxMessage } from '../../domain/messaging/outbox-message.ts';
import { Money, type MoneyProps } from '../../domain/money/money.ts';
import { DomainError } from '../../domain/shared/domain-error.ts';
import { FailureCode } from '../../domain/wagering/failure-code.ts';
import { hashBusinessPayload } from '../../domain/wagering/payload-hash.ts';
import * as rules from '../../domain/wagering/transaction-rules.ts';
import type { WagerKind } from '../../domain/wagering/transaction-rules.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/wagering/wager-events.ts';
import { WagerTransaction, type WagerStatus as TransactionStatus } from '../../domain/wagering/wager-transaction.ts';
import { WalletBalanceChanged } from '../../domain/wallet/wallet-events.ts';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.ts';
import { Wallet, type WalletState } from '../../domain/wallet/wallet.ts';
import { moneyFromMinorUnits, minorUnitsOf } from '../../infrastructure/persistence/money-mapper.ts';
import type { Orm } from '../../infrastructure/persistence/orm.ts';
import { queryAll, queryOne, runSql, type Em } from '../../infrastructure/persistence/sql.ts';
import { Metrics } from '../../infrastructure/metrics/metrics.ts';
import { log } from '../../infrastructure/logging/logger.ts';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  InvalidTransactionError,
  UnsupportedTransactionKindError,
  WalletNotFoundError,
} from '../errors.ts';

export interface SubmitWagerInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}

export interface InboxRef {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

/**
 * Status devolvido pela API. FAILED aparece quando a transação já falhou de forma permanente:
 * a resposta é um replay, e a transação não deve ser reenviada sem investigação.
 */
export type WagerStatus = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface SubmitWagerOptions {
  /** Tentativas de reprocessamento antes de rejeitar por referência ausente. */
  maxAttempts?: number;
  /** Idade máxima, em ms, de uma transação pendente de referência. */
  ttlMs?: number;
  /** Base do backoff exponencial, em ms. */
  backoffBaseMs?: number;
}

const DEFAULTS: Required<SubmitWagerOptions> = {
  maxAttempts: 5,
  ttlMs: 24 * 60 * 60 * 1000,
  backoffBaseMs: 1000,
};
const MAX_BACKOFF_MS = 60_000;
/** Espera acima deste tempo para obter o lock é contada como disputa. */
const LOCK_CONTENTION_MS = 50;

const WAGER_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, currency, round_id, game_id, kind, amount_minor,
  reference_external_transaction_id, reference_transaction_id, status, failure_code,
  reference_attempts, next_reference_check_at, processed_at, created_at, balance_observed_minor`;

const WALLET_COLUMNS = 'id, player_id, currency, balance_minor, version, created_at, updated_at';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_minor: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface WagerRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  currency: string;
  round_id: string;
  game_id: string;
  kind: WagerKind;
  amount_minor: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerStatus;
  failure_code: FailureCode | null;
  reference_attempts: number;
  next_reference_check_at: Date | null;
  processed_at: Date | null;
  created_at: Date;
  balance_observed_minor: string | null;
}


/** Movimento de saldo feito nesta transação: a wallet nova e o lançamento que a produziu. */
interface Movement {
  wallet: Wallet;
  entry: WalletLedgerEntry;
}

type Resolution =
  | { outcome: 'ok'; referenceId: string | null; reference: WagerTransaction | null }
  | { outcome: 'pending' }
  | { outcome: 'reject'; code: FailureCode };

/**
 * Processa todas as transações de aposta: BET, WIN, LOSS, REFUND e ROLLBACK, além das
 * que aguardam referência (PENDING_REFERENCE).
 *
 * Concorrência: toda operação começa com `SELECT ... FOR UPDATE` na wallet. Como toda
 * referência fica na mesma wallet, reversões concorrentes da mesma transação são
 * serializadas e a segunda vê a primeira já confirmada.
 *
 * Regras de estado: quem decide a transição é a entidade `WagerTransaction`. O UPDATE
 * repete a condição do estado anterior (`AND status = ?`), como garantia final no banco.
 *
 * Atomicidade: transação, saldo, lançamento e outbox são gravados juntos ou não são.
 */
export class SubmitWagerUseCase {
  private readonly options: Required<SubmitWagerOptions>;

  constructor(
    private readonly orm: Orm,
    options: SubmitWagerOptions = {},
    private readonly metrics: Metrics = new Metrics(),
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Processa a transação e registra as métricas do processamento.
   *
   * `options.inbox`, quando informado, registra a mensagem recebida da fila na mesma
   * transação da aposta. Redelivery da mesma mensagem cai no replay, sem efeito duplicado.
   */
  async execute(input: SubmitWagerInput, options: { inbox?: InboxRef } = {}): Promise<SubmitWagerResult> {
    const started = performance.now();
    try {
      const result = await this.run(input, options);
      // Depois do commit: o log só sai quando o resultado já está gravado.
      log(result.status === 'REJECTED' ? 'warn' : 'info', 'wager processed', {
        correlationId: result.transactionId,
        transactionId: result.transactionId,
        providerId: input.providerId,
        walletId: input.walletId,
        externalTransactionId: input.externalTransactionId,
        kind: input.kind,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
      if (result.idempotentReplay) {
        this.metrics.increment('wager_duplicates_detected_total', 'Requisições repetidas detectadas pela idempotência', {
          kind: input.kind,
        });
      } else {
        // Só transações novas: uma repetição não é uma transação nova.
        this.metrics.increment('wager_transactions_total', 'Transações novas processadas por tipo e status', {
          kind: input.kind,
          status: result.status,
        });
      }
      return result;
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'UNEXPECTED';
      this.metrics.increment('wager_errors_total', 'Transações que terminaram com erro, por código', { code });
      // Antes da transação existir, o identificador de correlação é a Idempotency-Key.
      log('warn', 'wager failed', {
        correlationId: input.idempotencyKey,
        providerId: input.providerId,
        walletId: input.walletId,
        externalTransactionId: input.externalTransactionId,
        kind: input.kind,
        code,
      });
      throw error;
    } finally {
      this.metrics.observe('wager_processing_seconds', 'Tempo de processamento de uma transação', (performance.now() - started) / 1000, {
        kind: input.kind,
      });
    }
  }

  private async run(input: SubmitWagerInput, options: { inbox?: InboxRef }): Promise<SubmitWagerResult> {
    if (!rules.isSupportedKind(input.kind)) {
      throw new UnsupportedTransactionKindError(input.kind);
    }
    const kind = input.kind;
    const reference = input.referenceExternalTransactionId ?? null;
    if (rules.requiresReference(kind) && reference === null) {
      throw new InvalidRequestError(`${kind} requires referenceExternalTransactionId`);
    }
    if (!rules.acceptsReference(kind) && reference !== null) {
      throw new InvalidRequestError(`${kind} does not accept referenceExternalTransactionId`);
    }
    const amount = Money.from(input.money);
    const payloadHash = payloadHashFor(input);

    return this.orm.transaction(async (tx) => {
      const now = new Date();
      const walletRow = await this.lockWallet(tx, input.walletId);
      if (walletRow.player_id !== input.playerId) {
        throw new InvalidTransactionError('PLAYER_WALLET_MISMATCH', 'transaction player differs from wallet player');
      }
      if (walletRow.currency !== amount.currency) {
        throw new InvalidTransactionError('CURRENCY_WALLET_MISMATCH', 'transaction currency differs from wallet currency');
      }

      if (options.inbox) {
        // Gravada aqui e não antes: se a aposta falhar, a mensagem também volta a ser processada.
        const inbox = InboxMessage.receive({ ...options.inbox, at: now });
        inbox.markProcessed(now);
        const message = inbox.toState();
        await runSql(
          tx,
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
          [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt],
        );
      }

      const existing = await queryOne<WagerRow>(
        tx,
        `SELECT ${WAGER_COLUMNS} FROM wager_transactions
          WHERE (provider_id = ? AND external_transaction_id = ?) OR idempotency_key = ?`,
        [input.providerId, input.externalTransactionId, input.idempotencyKey],
      );
      if (existing) {
        return this.replay(existing, input, payloadHash);
      }

      const transaction = WagerTransaction.create({
        id: Bun.randomUUIDv7(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        kind,
        amount,
        referenceExternalTransactionId: reference,
        createdAt: now,
        payloadHash,
      });
      await insertPending(tx, transaction, { idempotencyKey: input.idempotencyKey, gameId: input.gameId, payloadHash });
      // Na fila, a causa dos eventos é a mensagem recebida. Na API, não há causa.
      return this.apply(tx, transaction, walletRow, now, undefined, options.inbox?.messageId);
    });
  }

  /**
   * Registra uma transação como FAILED depois que a falha de infraestrutura persistiu até o
   * limite de tentativas do consumidor. Grava a transação em estado final, sem saldo e sem
   * lançamento, para que fique auditável.
   *
   * Retorna `already` quando a transação já existe, porque outra tentativa a processou ou
   * registrou. Se a gravação também falhar (banco fora, carteira inexistente), o erro sobe e
   * o chamador decide o que fazer.
   */
  async recordInfrastructureFailure(
    input: SubmitWagerInput,
  ): Promise<{ outcome: 'recorded'; transactionId: string } | { outcome: 'already' }> {
    if (!rules.isSupportedKind(input.kind)) {
      throw new UnsupportedTransactionKindError(input.kind);
    }
    const kind = input.kind;
    const amount = Money.from(input.money);
    const payloadHash = payloadHashFor(input);

    return this.orm.transaction(async (tx) => {
      const now = new Date();
      await this.lockWallet(tx, input.walletId);
      const existing = await queryOne<{ id: string }>(
        tx,
        `SELECT id FROM wager_transactions
          WHERE (provider_id = ? AND external_transaction_id = ?) OR idempotency_key = ?`,
        [input.providerId, input.externalTransactionId, input.idempotencyKey],
      );
      if (existing) {
        return { outcome: 'already' as const };
      }

      const transaction = WagerTransaction.create({
        id: Bun.randomUUIDv7(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        kind,
        amount,
        referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
        createdAt: now,
        payloadHash,
      });
      transaction.fail({ at: now, code: FailureCode.InfrastructureFailure });
      await insertPending(tx, transaction, { idempotencyKey: input.idempotencyKey, gameId: input.gameId, payloadHash });
      await saveTransition(tx, transaction, 'PENDING');
      this.metrics.increment('wager_transactions_total', 'Transações novas processadas por tipo e status', {
        kind,
        status: 'FAILED',
      });
      return { outcome: 'recorded' as const, transactionId: transaction.id };
    });
  }

  /**
   * Reprocessa transações PENDING_REFERENCE vencidas. Chamado pelo worker com backoff.
   * Cada transação é reavaliada sob o lock da sua wallet e só é processada se ainda estiver pendente.
   */
  async reprocessPending(now: Date, limit = 50): Promise<number> {
    const candidates = await queryAll<{ id: string; wallet_id: string }>(
      this.orm.manager,
      `SELECT id, wallet_id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_check_at <= ?
        ORDER BY next_reference_check_at
        LIMIT ?`,
      [now, limit],
    );

    let processed = 0;
    for (const candidate of candidates) {
      const settled = await this.orm.transaction(async (tx) => {
        const walletRow = await this.lockWallet(tx, candidate.wallet_id);
        const row = await queryOne<WagerRow>(
          tx,
          `SELECT ${WAGER_COLUMNS} FROM wager_transactions
            WHERE id = ? AND status = 'PENDING_REFERENCE' AND next_reference_check_at <= ?`,
          [candidate.id, now],
        );
        if (!row) {
          return null;
        }
        const transaction = toTransaction(row);
        const resolution = await this.resolveReference(tx, transaction);

        if (resolution.outcome !== 'pending') {
          await this.apply(tx, transaction, walletRow, now, resolution);
          return transaction;
        }

        const attempts = transaction.attempts + 1;
        if (attempts >= this.options.maxAttempts || transaction.hasExpired(now, this.options.ttlMs)) {
          await this.reject(tx, transaction, walletRow, FailureCode.ReferenceNotFound, now, attempts);
        } else {
          this.metrics.increment('wager_reference_retries_total', 'Reprocessamentos de transações aguardando referência', {
            kind: transaction.kind,
          });
          await this.park(tx, transaction, walletRow, now, attempts, false);
        }
        return transaction;
      });
      if (settled) {
        processed += 1;
        log('info', 'pending reference reprocessed', transactionLogFields(settled));
      }
    }
    return processed;
  }

  /** Aplica a regra de negócio a uma transação já gravada, sob o lock da wallet. */
  private async apply(
    tx: Em,
    transaction: WagerTransaction,
    walletRow: WalletRow,
    now: Date,
    resolution?: Resolution,
    causationId?: string,
  ): Promise<SubmitWagerResult> {
    const resolved = resolution ?? (await this.resolveReference(tx, transaction));

    if (resolved.outcome === 'pending') {
      return this.park(tx, transaction, walletRow, now, transaction.attempts, true, causationId);
    }
    if (resolved.outcome === 'reject') {
      return this.reject(tx, transaction, walletRow, resolved.code, now, transaction.attempts, causationId);
    }

    const direction = transaction.ledgerDirectionFor(resolved.reference ?? undefined);
    if (direction === null) {
      return this.markProcessed(tx, transaction, walletRow, resolved.referenceId, now, undefined, causationId);
    }

    const wallet = Wallet.rehydrate(toWalletState(walletRow));
    const movementProps = { entryId: Bun.randomUUIDv7(), transactionId: transaction.id, amount: transaction.amount, at: now };
    let entry: WalletLedgerEntry;
    try {
      entry = direction === LedgerDirection.Debit ? wallet.debit(movementProps) : wallet.credit(movementProps);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'WALLET_INSUFFICIENT_FUNDS') {
        const code = transaction.kind === 'ROLLBACK' ? FailureCode.ReversalWouldBeNegative : FailureCode.InsufficientFunds;
        return this.reject(tx, transaction, walletRow, code, now, transaction.attempts, causationId);
      }
      throw error;
    }

    await persistMovement(tx, wallet, walletRow.version, entry, now);
    return this.markProcessed(tx, transaction, walletRow, resolved.referenceId, now, { wallet, entry }, causationId);
  }

  /** Decide se a referência existe e é válida para este tipo de transação. */
  private async resolveReference(tx: Em, transaction: WagerTransaction): Promise<Resolution> {
    if (transaction.referenceExternalTransactionId === null) {
      return { outcome: 'ok', referenceId: null, reference: null };
    }

    const ref = await queryOne<WagerRow>(
      tx,
      `SELECT ${WAGER_COLUMNS} FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
      [transaction.providerId, transaction.referenceExternalTransactionId],
    );
    if (!ref) {
      return { outcome: 'pending' };
    }

    const sameContext =
      ref.wallet_id === transaction.walletId &&
      ref.player_id === transaction.playerId &&
      ref.currency === transaction.currency &&
      ref.round_id === transaction.roundId;
    if (!sameContext) {
      return { outcome: 'reject', code: FailureCode.ReferenceMismatch };
    }
    if (!rules.allowedReferenceKinds(transaction.kind).includes(ref.kind)) {
      return { outcome: 'reject', code: FailureCode.ReferenceInvalidKind };
    }
    if (ref.status !== 'PROCESSED') {
      return { outcome: 'reject', code: FailureCode.ReferenceNotProcessed };
    }

    if (rules.isOutcome(transaction.kind)) {
      // Uma BET recebe um único desfecho. Se já há WIN ou LOSS apontando para ela, este é recusado.
      // Roda sob o lock da wallet, então dois desfechos concorrentes se enxergam em ordem.
      const settled = await queryOne<{ id: string }>(
        tx,
        `SELECT id FROM wager_transactions
          WHERE provider_id = ? AND reference_external_transaction_id = ?
            AND kind IN ('WIN', 'LOSS') AND status IN ('PENDING', 'PROCESSED') AND id <> ?`,
        [transaction.providerId, transaction.referenceExternalTransactionId, transaction.id],
      );
      if (settled) {
        return { outcome: 'reject', code: FailureCode.ReferenceAlreadySettled };
      }
    }

    if (rules.isReversal(transaction.kind)) {
      if (BigInt(ref.amount_minor) !== minorUnitsOf(transaction.amount)) {
        return { outcome: 'reject', code: FailureCode.ReferenceAmountMismatch };
      }
      // Cada transação só pode ser revertida uma vez, por REFUND ou ROLLBACK.
      const alreadyReversed = await queryOne<{ id: string }>(
        tx,
        `SELECT id FROM wager_transactions
          WHERE reference_transaction_id = ? AND kind IN ('REFUND', 'ROLLBACK')
            AND status IN ('PENDING', 'PROCESSED') AND id <> ?`,
        [ref.id, transaction.id],
      );
      if (alreadyReversed) {
        return { outcome: 'reject', code: FailureCode.ReferenceAlreadyReversed };
      }
    }

    return { outcome: 'ok', referenceId: ref.id, reference: toTransaction(ref) };
  }

  private async markProcessed(
    tx: Em,
    transaction: WagerTransaction,
    walletRow: WalletRow,
    referenceId: string | null,
    now: Date,
    movement?: Movement,
    causationId?: string,
  ): Promise<SubmitWagerResult> {
    const balance = movement ? movement.wallet.balance : moneyFromMinorUnits(walletRow.balance_minor, walletRow.currency);
    const from = transaction.status;
    transaction.markProcessed({ at: now, referenceTransactionId: referenceId, balanceObserved: balance });
    await saveTransition(tx, transaction, from);

    await enqueueEvent(tx, WagerTransactionProcessed.from(transaction, eventContext(now, causationId)));
    if (movement) {
      await enqueueEvent(tx, WalletBalanceChanged.from(movement.wallet, movement.entry, eventContext(now, causationId)));
    }

    return {
      transactionId: transaction.id,
      status: 'PROCESSED',
      balance: balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async reject(
    tx: Em,
    transaction: WagerTransaction,
    walletRow: WalletRow,
    code: FailureCode,
    now: Date,
    attempts: number,
    causationId?: string,
  ): Promise<SubmitWagerResult> {
    const balance = moneyFromMinorUnits(walletRow.balance_minor, walletRow.currency);
    const from = transaction.status;
    transaction.reject({ at: now, code, attempts, balanceObserved: balance });
    await saveTransition(tx, transaction, from);

    await enqueueEvent(tx, WagerTransactionRejected.from(transaction, eventContext(now, causationId)));
    return {
      transactionId: transaction.id,
      status: 'REJECTED',
      balance: balance.toJSON(),
      failureCode: code,
      idempotentReplay: false,
    };
  }

  private async park(
    tx: Em,
    transaction: WagerTransaction,
    walletRow: WalletRow,
    now: Date,
    attempts: number,
    announce: boolean,
    causationId?: string,
  ): Promise<SubmitWagerResult> {
    const balance = moneyFromMinorUnits(walletRow.balance_minor, walletRow.currency);
    const from = transaction.status;
    transaction.awaitReference({
      attempts,
      nextCheckAt: new Date(now.getTime() + this.backoffMs(attempts)),
      balanceObserved: balance,
    });
    await saveTransition(tx, transaction, from);

    if (announce) {
      await enqueueEvent(tx, WagerTransactionPendingReference.from(transaction, eventContext(now, causationId)));
    }
    return {
      transactionId: transaction.id,
      status: 'PENDING_REFERENCE',
      balance: balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private backoffMs(attempts: number): number {
    return Math.min(this.options.backoffBaseMs * 2 ** attempts, MAX_BACKOFF_MS);
  }

  private async lockWallet(tx: Em, walletId: string): Promise<WalletRow> {
    const started = performance.now();
    const row = await queryOne<WalletRow>(
      tx,
      `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`,
      [walletId],
    );
    // Espera pelo lock: um tempo alto indica disputa com outra transação na mesma wallet.
    const waitedMs = performance.now() - started;
    this.metrics.observe('wallet_lock_wait_seconds', 'Tempo para obter o lock da wallet', waitedMs / 1000);
    if (waitedMs > LOCK_CONTENTION_MS) {
      this.metrics.increment('wallet_lock_contention_total', 'Locks de wallet que esperaram acima do limiar');
    }
    if (!row) {
      throw new WalletNotFoundError(walletId);
    }
    return row;
  }

  private replay(row: WagerRow, input: SubmitWagerInput, payloadHash: string): SubmitWagerResult {
    if (row.idempotency_key !== input.idempotencyKey || !toTransaction(row).matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(input.idempotencyKey);
    }
    return {
      transactionId: row.id,
      status: row.status,
      balance: moneyFromMinorUnits(row.balance_observed_minor ?? '0', row.currency).toJSON(),
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
      idempotentReplay: true,
    };
  }
}

/**
 * Hash dos campos de negócio. Usado tanto na transação normal quanto no registro de falha,
 * então uma repetição depois de FAILED bate com o hash gravado e não vira conflito.
 */
function payloadHashFor(input: SubmitWagerInput): string {
  const amount = Money.from(input.money);
  return hashBusinessPayload({
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: amount.toString(), currency: amount.currency },
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
  });
}

function eventContext(occurredAt: Date, causationId?: string): EventContext {
  return { eventId: Bun.randomUUIDv7(), occurredAt, ...(causationId ? { causationId } : {}) };
}

/** Campos de rastreio de uma transação. Não inclui valores: o log não guarda payload financeiro. */
function transactionLogFields(transaction: WagerTransaction): Record<string, unknown> {
  return {
    correlationId: transaction.id,
    transactionId: transaction.id,
    providerId: transaction.providerId,
    walletId: transaction.walletId,
    externalTransactionId: transaction.externalTransactionId,
    kind: transaction.kind,
    status: transaction.status,
    failureCode: transaction.failureCode ?? undefined,
  };
}

async function insertPending(
  tx: Em,
  transaction: WagerTransaction,
  extra: { idempotencyKey: string; gameId: string; payloadHash: string },
): Promise<void> {
  await runSql(
    tx,
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, currency, round_id, game_id, kind, amount_minor,
       reference_external_transaction_id, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    [
      transaction.id,
      transaction.providerId,
      transaction.externalTransactionId,
      extra.idempotencyKey,
      extra.payloadHash,
      transaction.walletId,
      transaction.playerId,
      transaction.currency,
      transaction.roundId,
      extra.gameId,
      transaction.kind,
      minorUnitsOf(transaction.amount).toString(),
      transaction.referenceExternalTransactionId,
      transaction.createdAt,
    ],
  );
}

/**
 * Grava a nova situação da transação. `from` é o estado que a entidade tinha antes da
 * transição: o UPDATE só casa se ninguém tiver mudado a linha desde então.
 */
async function saveTransition(tx: Em, transaction: WagerTransaction, from: TransactionStatus): Promise<void> {
  const state = transaction.toState();
  const affected = await runSql(
    tx,
    `UPDATE wager_transactions
        SET status = ?, failure_code = ?, processed_at = ?, balance_observed_minor = ?,
            reference_transaction_id = ?, reference_attempts = ?, next_reference_check_at = ?
      WHERE id = ? AND status = ?`,
    [
      state.status,
      state.failureCode,
      state.processedAt,
      transaction.balanceObserved ? minorUnitsOf(transaction.balanceObserved).toString() : null,
      state.referenceTransactionId,
      state.attempts,
      state.nextReferenceCheckAt,
      state.id,
      from,
    ],
  );
  if (affected !== 1) {
    // Com o lock da wallet isso não acontece; falhar alto preserva a invariante se acontecer.
    throw new Error(`transaction ${state.id} changed status concurrently`);
  }
}

async function persistMovement(
  tx: Em,
  wallet: Wallet,
  previousVersion: number,
  entry: WalletLedgerEntry,
  now: Date,
): Promise<void> {
  const updated = await runSql(
    tx,
    'UPDATE wallets SET balance_minor = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?',
    [minorUnitsOf(wallet.balance).toString(), wallet.version, now, wallet.id, previousVersion],
  );
  if (updated !== 1) {
    // Com o lock da wallet isso não acontece; falhar alto preserva a invariante se acontecer.
    throw new Error(`optimistic check failed for wallet ${wallet.id}`);
  }

  await runSql(
    tx,
    `INSERT INTO wallet_ledger_entries (
       id, wallet_id, transaction_id, wallet_version, direction, currency,
       amount_minor, balance_before_minor, balance_after_minor, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      wallet.id,
      entry.transactionId,
      wallet.version,
      entry.direction,
      entry.money.currency,
      minorUnitsOf(entry.money).toString(),
      minorUnitsOf(entry.balanceBefore).toString(),
      minorUnitsOf(entry.balanceAfter).toString(),
      now,
    ],
  );
}

/** Grava o evento na outbox, na mesma transação da mudança que o gerou. */
async function enqueueEvent(tx: Em, event: IntegrationEvent<object>): Promise<void> {
  const message = OutboxMessage.fromEvent(event).toState();
  await runSql(
    tx,
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
     VALUES (?, ?, ?, CAST(? AS jsonb), ?, ?)`,
    [message.id, message.aggregateId, message.eventType, JSON.stringify(message.payload), message.occurredAt, message.nextAttemptAt],
  );
}

function toTransaction(row: WagerRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    kind: row.kind,
    amount: moneyFromMinorUnits(row.amount_minor, row.currency).toJSON(),
    referenceExternalTransactionId: row.reference_external_transaction_id,
    createdAt: new Date(row.created_at),
    payloadHash: row.payload_hash,
    status: row.status,
    failureCode: row.failure_code,
    attempts: row.reference_attempts,
    nextReferenceCheckAt: row.next_reference_check_at ? new Date(row.next_reference_check_at) : null,
    processedAt: row.processed_at ? new Date(row.processed_at) : null,
    referenceTransactionId: row.reference_transaction_id,
    balanceObserved:
      row.balance_observed_minor === null ? null : moneyFromMinorUnits(row.balance_observed_minor, row.currency).toJSON(),
  });
}

function toWalletState(row: WalletRow): WalletState {
  return {
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: moneyFromMinorUnits(row.balance_minor, row.currency).toJSON(),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
