import { IntegrationEvent, type EventContext } from '../messaging/integration-event.ts';
import type { MoneyProps } from '../money/money.ts';
import type { FailureCode } from './failure-code.ts';
import type { WagerKind } from './transaction-rules.ts';
import type { WagerTransaction } from './wager-transaction.ts';

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  kind: WagerKind;
  money: MoneyProps;
  referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(context, transaction.id, {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      kind: transaction.kind,
      money: transaction.amount.toJSON(),
      ...(transaction.referenceTransactionId ? { referenceTransactionId: transaction.referenceTransactionId } : {}),
    });
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  kind: WagerKind;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    if (transaction.failureCode === null) {
      throw new Error(`transaction ${transaction.id} has no failure code`);
    }
    return new WagerTransactionRejected(context, transaction.id, {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      kind: transaction.kind,
      failureCode: transaction.failureCode,
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  kind: WagerKind;
  referenceExternalTransactionId: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(context, transaction.id, {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      kind: transaction.kind,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    });
  }
}
