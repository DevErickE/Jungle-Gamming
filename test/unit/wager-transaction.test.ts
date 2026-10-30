import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../src/domain/shared/domain-error.ts';
import { Money } from '../../src/domain/money/money.ts';
import { FailureCode } from '../../src/domain/wagering/failure-code.ts';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry.ts';
import { WagerTransaction, type CreateWagerTransactionProps } from '../../src/domain/wagering/wager-transaction.ts';
import { WagerTransactionProcessed, WagerTransactionRejected } from '../../src/domain/wagering/wager-events.ts';

const at = new Date('2026-10-28T12:00:00.000Z');

function newBetProps(): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    kind: 'BET',
    amount: Money.from({ amount: '10.00', currency: 'BRL' }),
    referenceExternalTransactionId: null,
    createdAt: at,
    payloadHash: 'hash-1',
  };
}

function newBet(): WagerTransaction {
  return WagerTransaction.create(newBetProps());
}

const balance = Money.from({ amount: '90.00', currency: 'BRL' });

describe('WagerTransaction', () => {
  test('nasce PENDING, sem resultado nem referência', () => {
    const tx = newBet();
    expect(tx.status).toBe('PENDING');
    expect(tx.isFinal).toBe(false);
    expect(tx.processedAt).toBeNull();
    expect(tx.failureCode).toBeNull();
  });

  test('aprova e vira estado final', () => {
    const tx = newBet();
    tx.markProcessed({ at, referenceTransactionId: null, balanceObserved: balance });
    expect(tx.status).toBe('PROCESSED');
    expect(tx.isFinal).toBe(true);
    expect(tx.balanceObserved?.toString()).toBe('90.00');
  });

  test('não muda depois de PROCESSED', () => {
    const tx = newBet();
    tx.markProcessed({ at, referenceTransactionId: null, balanceObserved: balance });
    expect(() => tx.reject({ at, code: FailureCode.InsufficientFunds, attempts: 0, balanceObserved: balance })).toThrow(
      DomainError,
    );
    expect(tx.status).toBe('PROCESSED');
  });

  test('não muda depois de REJECTED', () => {
    const tx = newBet();
    tx.reject({ at, code: FailureCode.InsufficientFunds, attempts: 0, balanceObserved: balance });
    expect(() => tx.markProcessed({ at, referenceTransactionId: null, balanceObserved: balance })).toThrow(
      'already in a final state',
    );
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('erro de transição é DomainError com código estável', () => {
    const tx = newBet();
    tx.fail({ at, code: FailureCode.ReferenceNotFound, balanceObserved: balance });
    try {
      tx.markProcessed({ at, referenceTransactionId: null, balanceObserved: balance });
      throw new Error('expected a transition error');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('WAGER_INVALID_TRANSITION');
    }
  });

  test('espera referência e pode reagendar várias vezes antes de resolver', () => {
    const tx = newBet();
    const next = new Date(at.getTime() + 1000);
    tx.awaitReference({ attempts: 1, nextCheckAt: next, balanceObserved: balance });
    tx.awaitReference({ attempts: 2, nextCheckAt: next, balanceObserved: balance });
    expect(tx.status).toBe('PENDING_REFERENCE');
    expect(tx.attempts).toBe(2);
    expect(tx.nextReferenceCheckAt).toEqual(next);
    tx.markProcessed({ at, referenceTransactionId: 'tx-0', balanceObserved: balance });
    expect(tx.nextReferenceCheckAt).toBeNull();
    expect(tx.referenceTransactionId).toBe('tx-0');
  });

  test('expira pelo TTL a partir da criação', () => {
    const tx = newBet();
    expect(tx.hasExpired(new Date(at.getTime() + 999), 1000)).toBe(false);
    expect(tx.hasExpired(new Date(at.getTime() + 1000), 1000)).toBe(true);
  });

  test('rehydrate preserva o estado sem revalidar transições', () => {
    const tx = newBet();
    tx.reject({ at, code: FailureCode.InsufficientFunds, attempts: 0, balanceObserved: balance });
    const copy = WagerTransaction.rehydrate(tx.toState());
    expect(copy.status).toBe('REJECTED');
    expect(copy.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(copy.toState()).toEqual(tx.toState());
  });
});

describe('consultas de domínio', () => {
  test('matchesPayload aceita só o hash gravado', () => {
    const tx = newBet();
    expect(tx.matchesPayload('hash-1')).toBe(true);
    expect(tx.matchesPayload('hash-2')).toBe(false);
  });

  test('affectsBalance é falso só para LOSS', () => {
    expect(newBet().affectsBalance()).toBe(true);
    const loss = WagerTransaction.create({
      ...newBetProps(),
      kind: 'LOSS',
    });
    expect(loss.affectsBalance()).toBe(false);
  });

  test('ledgerDirectionFor: BET debita, WIN credita, LOSS não tem direção, ROLLBACK depende da referência', () => {
    expect(newBet().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    const win = WagerTransaction.create({ ...newBetProps(), kind: 'WIN' });
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const loss = WagerTransaction.create({ ...newBetProps(), kind: 'LOSS' });
    expect(loss.ledgerDirectionFor()).toBeNull();
    const rollback = WagerTransaction.create({ ...newBetProps(), kind: 'ROLLBACK' });
    expect(rollback.ledgerDirectionFor(newBet())).toBe(LedgerDirection.Credit);
    expect(() => rollback.ledgerDirectionFor()).toThrow();
  });
});

describe('eventos de integração', () => {
  test('WagerTransactionProcessed usa o envelope da spec e o id do agregado como correlação', () => {
    const tx = newBet();
    tx.markProcessed({ at, referenceTransactionId: null, balanceObserved: balance });
    const event = WagerTransactionProcessed.from(tx, { eventId: 'evt-1', occurredAt: at });
    const json = JSON.parse(JSON.stringify(event));
    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'tx-1',
      correlationId: 'tx-1',
      occurredAt: at.toISOString(),
      version: 1,
      data: {
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    });
  });

  test('WagerTransactionRejected leva o código de falha', () => {
    const tx = newBet();
    tx.reject({ at, code: FailureCode.InsufficientFunds, attempts: 0, balanceObserved: balance });
    const event = WagerTransactionRejected.from(tx, { eventId: 'evt-2', occurredAt: at });
    expect(event.toJSON().data).toEqual({
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      kind: 'BET',
      failureCode: FailureCode.InsufficientFunds,
    });
  });

  test('evento de transação sem falha não é montado', () => {
    expect(() => WagerTransactionRejected.from(newBet(), { eventId: 'evt-3', occurredAt: at })).toThrow();
  });
});
