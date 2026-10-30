import { DomainError } from '../shared/domain-error.ts';
import { Money, type MoneyProps } from '../money/money.ts';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.ts';
import { FailureCode } from './failure-code.ts';
import * as rules from './transaction-rules.ts';
import type { WagerKind } from './transaction-rules.ts';

export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

/**
 * Transições permitidas. PROCESSED, REJECTED e FAILED não têm saída: são estados finais.
 * O SQL (CHECK e WHERE status = ...) repete essa regra no banco, como garantia final.
 */
const TRANSITIONS: Readonly<Record<WagerStatus, readonly WagerStatus[]>> = {
  PENDING: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  PENDING_REFERENCE: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerKind;
  amount: Money;
  referenceExternalTransactionId: string | null;
  createdAt: Date;
  /** Hash dos campos de negócio, calculado pela camada de aplicação. */
  payloadHash: string;
}

/** Forma serializável, usada para gravar e reconstruir a transação. */
export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerKind;
  amount: MoneyProps;
  referenceExternalTransactionId: string | null;
  createdAt: Date;
  payloadHash: string;
  status: WagerStatus;
  failureCode: FailureCode | null;
  attempts: number;
  nextReferenceCheckAt: Date | null;
  processedAt: Date | null;
  referenceTransactionId: string | null;
  balanceObserved: MoneyProps | null;
}

interface Fields {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerKind;
  amount: Money;
  referenceExternalTransactionId: string | null;
  createdAt: Date;
  payloadHash: string;
  status: WagerStatus;
  failureCode: FailureCode | null;
  attempts: number;
  nextReferenceCheckAt: Date | null;
  processedAt: Date | null;
  referenceTransactionId: string | null;
  balanceObserved: Money | null;
}

/**
 * Entidade de uma aposta. Nasce PENDING e só muda de estado por métodos que checam a
 * transição. Com isso, aprovar uma transação já rejeitada é um erro de domínio, não um
 * UPDATE que simplesmente não casa nenhuma linha.
 */
export class WagerTransaction {
  private constructor(private readonly fields: Fields) {}

  /** Nova transação, ainda não processada. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction({
      ...props,
      status: 'PENDING',
      failureCode: null,
      attempts: 0,
      nextReferenceCheckAt: null,
      processedAt: null,
      referenceTransactionId: null,
      balanceObserved: null,
    });
  }

  /** Reconstrução a partir da persistência. Não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({
      ...state,
      amount: Money.from(state.amount),
      balanceObserved: state.balanceObserved ? Money.from(state.balanceObserved) : null,
    });
  }

  get id(): string {
    return this.fields.id;
  }
  get providerId(): string {
    return this.fields.providerId;
  }
  get externalTransactionId(): string {
    return this.fields.externalTransactionId;
  }
  get walletId(): string {
    return this.fields.walletId;
  }
  get playerId(): string {
    return this.fields.playerId;
  }
  get roundId(): string {
    return this.fields.roundId;
  }
  get kind(): WagerKind {
    return this.fields.kind;
  }
  get amount(): Money {
    return this.fields.amount;
  }
  get currency(): string {
    return this.fields.amount.currency;
  }
  get referenceExternalTransactionId(): string | null {
    return this.fields.referenceExternalTransactionId;
  }
  get createdAt(): Date {
    return this.fields.createdAt;
  }
  get status(): WagerStatus {
    return this.fields.status;
  }
  get failureCode(): FailureCode | null {
    return this.fields.failureCode;
  }
  get attempts(): number {
    return this.fields.attempts;
  }
  get nextReferenceCheckAt(): Date | null {
    return this.fields.nextReferenceCheckAt;
  }
  get processedAt(): Date | null {
    return this.fields.processedAt;
  }
  get referenceTransactionId(): string | null {
    return this.fields.referenceTransactionId;
  }
  get balanceObserved(): Money | null {
    return this.fields.balanceObserved;
  }
  get payloadHash(): string {
    return this.fields.payloadHash;
  }

  get isFinal(): boolean {
    return TRANSITIONS[this.fields.status].length === 0;
  }

  /** O payload recebido é o mesmo gravado? Mesma chave com payload diferente é conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.fields.payloadHash === payloadHash;
  }

  /** Se o tipo mexe no saldo quando aplicado. LOSS nunca mexe. */
  affectsBalance(): boolean {
    return this.fields.kind !== 'LOSS';
  }

  /**
   * Direção do lançamento, ou null quando não há movimento. ROLLBACK depende do tipo da
   * transação que reverte, por isso recebe a referência.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    return rules.balanceDirection(this.fields.kind, reference?.kind);
  }

  /** A referência ainda não apareceu e o TTL da transação já venceu. */
  hasExpired(now: Date, ttlMs: number): boolean {
    return now.getTime() - this.fields.createdAt.getTime() >= ttlMs;
  }

  /** Aprova. `referenceTransactionId` é a transação original, quando há uma (REFUND, ROLLBACK). */
  markProcessed(input: { at: Date; referenceTransactionId: string | null; balanceObserved: Money }): void {
    this.transitionTo('PROCESSED');
    this.fields.processedAt = input.at;
    this.fields.referenceTransactionId = input.referenceTransactionId;
    this.fields.failureCode = null;
    this.fields.nextReferenceCheckAt = null;
    this.fields.balanceObserved = input.balanceObserved;
  }

  /** Rejeita com um código estável. Estado final. */
  reject(input: { at: Date; code: FailureCode; attempts: number; balanceObserved: Money }): void {
    this.transitionTo('REJECTED');
    this.fields.processedAt = input.at;
    this.fields.failureCode = input.code;
    this.fields.attempts = input.attempts;
    this.fields.nextReferenceCheckAt = null;
    this.fields.balanceObserved = input.balanceObserved;
  }

  /** Espera a referência. Pode ser chamado de novo, a cada nova tentativa, até o próximo check. */
  awaitReference(input: { attempts: number; nextCheckAt: Date; balanceObserved: Money }): void {
    this.transitionTo('PENDING_REFERENCE');
    this.fields.attempts = input.attempts;
    this.fields.nextReferenceCheckAt = input.nextCheckAt;
    this.fields.balanceObserved = input.balanceObserved;
  }

  /** Falha interna definitiva. Estado final. */
  fail(input: { at: Date; code: FailureCode; balanceObserved?: Money }): void {
    this.transitionTo('FAILED');
    this.fields.processedAt = input.at;
    this.fields.failureCode = input.code;
    this.fields.nextReferenceCheckAt = null;
    // Pode não haver saldo observado: a falha pode ter acontecido antes de ler a carteira.
    this.fields.balanceObserved = input.balanceObserved ?? null;
  }

  toState(): WagerTransactionState {
    const { amount, balanceObserved, ...rest } = this.fields;
    return {
      ...rest,
      amount: amount.toJSON(),
      balanceObserved: balanceObserved?.toJSON() ?? null,
    };
  }

  private transitionTo(next: WagerStatus): void {
    const current = this.fields.status;
    if (!TRANSITIONS[current].includes(next)) {
      const reason = TRANSITIONS[current].length === 0 ? 'already in a final state' : 'transition not allowed';
      throw new DomainError(
        'WAGER_INVALID_TRANSITION',
        `transaction ${this.fields.id}: ${current} -> ${next} (${reason})`,
      );
    }
    this.fields.status = next;
  }
}
