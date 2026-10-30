import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money.ts';
import { DomainError } from '../../src/domain/shared/domain-error.ts';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry.ts';
import { Wallet } from '../../src/domain/wallet/wallet.ts';

const AT = new Date('2026-07-29T15:00:00.000Z');
let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function openWallet(initial: string) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingEntryId: nextId('entry-open'),
    openingTransactionId: nextId('tx-open'),
    at: AT,
  });
}

function expectDomainError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`esperava DomainError ${code}`);
}

/** Reconstrói o saldo somando os lançamentos. Invariante: deve ser igual ao saldo da wallet. */
function replayLedger(entries: WalletLedgerEntry[], currency: string): Money {
  return entries.reduce(
    (balance, entry) =>
      entry.direction === LedgerDirection.Debit
        ? balance.subtract(entry.money)
        : balance.add(entry.money),
    Money.zero(currency),
  );
}

describe('Wallet.open', () => {
  test('saldo inicial positivo gera um CREDIT de abertura e version 1', () => {
    const { wallet, openingEntry } = openWallet('1000.00');

    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).not.toBeNull();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
  });

  test('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeNull();
  });

  test('saldo inicial negativo é rejeitado', () => {
    expectDomainError(() => openWallet('-1.00'), 'MONEY_INVALID_AMOUNT');
  });
});

describe('Wallet.debit', () => {
  test('debita, incrementa version e gera lançamento DEBIT balanceado', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit({
      entryId: 'e1',
      transactionId: 't1',
      amount: brl('25.00'),
      at: AT,
    });

    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });

  test('permite debitar até zerar o saldo', () => {
    const { wallet } = openWallet('80.00');
    wallet.debit({ entryId: 'e1', transactionId: 't1', amount: brl('80.00'), at: AT });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente é rejeitado e não altera a wallet', () => {
    const { wallet } = openWallet('100.00');
    expectDomainError(
      () => wallet.debit({ entryId: 'e1', transactionId: 't1', amount: brl('100.01'), at: AT }),
      'WALLET_INSUFFICIENT_FUNDS',
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('o saldo nunca fica negativo após uma sequência de débitos', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit({ entryId: 'e1', transactionId: 't1', amount: brl('80.00'), at: AT });
    expectDomainError(
      () => wallet.debit({ entryId: 'e2', transactionId: 't2', amount: brl('80.00'), at: AT }),
      'WALLET_INSUFFICIENT_FUNDS',
    );
    expect(wallet.balance.isNegative()).toBe(false);
    expect(wallet.balance.toString()).toBe('20.00');
  });

  test('valor zero ou negativo é rejeitado', () => {
    const { wallet } = openWallet('100.00');
    expectDomainError(
      () => wallet.debit({ entryId: 'e1', transactionId: 't1', amount: brl('0.00'), at: AT }),
      'WALLET_INVALID_AMOUNT',
    );
    expectDomainError(
      () => wallet.debit({ entryId: 'e2', transactionId: 't2', amount: brl('1.00').negate(), at: AT }),
      'WALLET_INVALID_AMOUNT',
    );
  });

  test('moeda diferente da wallet é rejeitada', () => {
    const { wallet } = openWallet('100.00');
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expectDomainError(
      () => wallet.debit({ entryId: 'e1', transactionId: 't1', amount: usd, at: AT }),
      'WALLET_CURRENCY_MISMATCH',
    );
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.credit', () => {
  test('credita, incrementa version e gera lançamento CREDIT balanceado', () => {
    const { wallet } = openWallet('10.00');
    const entry = wallet.credit({ entryId: 'e1', transactionId: 't1', amount: brl('5.50'), at: AT });

    expect(wallet.balance.toString()).toBe('15.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });
});

describe('Invariantes: saldo e ledger', () => {
  test('o saldo é sempre igual ao reconstruído pelo ledger', () => {
    const { wallet, openingEntry } = openWallet('500.00');
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];

    entries.push(wallet.debit({ entryId: 'e1', transactionId: 't1', amount: brl('120.00'), at: AT }));
    entries.push(wallet.credit({ entryId: 'e2', transactionId: 't2', amount: brl('0.10'), at: AT }));
    entries.push(wallet.debit({ entryId: 'e3', transactionId: 't3', amount: brl('30.05'), at: AT }));

    expect(replayLedger(entries, 'BRL').equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(4);
  });

  test('version incrementa exatamente uma vez por movimentação', () => {
    const { wallet } = openWallet('50.00');
    for (let i = 1; i <= 5; i++) {
      wallet.credit({ entryId: `e${i}`, transactionId: `t${i}`, amount: brl('1.00'), at: AT });
    }
    expect(wallet.version).toBe(6);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar transições', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: { amount: '42.00', currency: 'BRL' },
      version: 7,
      createdAt: AT,
      updatedAt: AT,
    });
    expect(wallet.balance.toString()).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});

describe('WalletLedgerEntry.create', () => {
  const base = {
    id: 'e1',
    walletId: 'wallet-1',
    transactionId: 't1',
    createdAt: AT,
  };

  test('rejeita aritmética inconsistente', () => {
    expectDomainError(
      () =>
        WalletLedgerEntry.create({
          ...base,
          direction: LedgerDirection.Debit,
          money: brl('10.00'),
          balanceBefore: brl('100.00'),
          balanceAfter: brl('100.00'),
        }),
      'LEDGER_UNBALANCED',
    );
  });

  test('rejeita lançamento com valor zero', () => {
    expectDomainError(
      () =>
        WalletLedgerEntry.create({
          ...base,
          direction: LedgerDirection.Credit,
          money: brl('0.00'),
          balanceBefore: brl('100.00'),
          balanceAfter: brl('100.00'),
        }),
      'LEDGER_INVALID_AMOUNT',
    );
  });

  test('rejeita saldo negativo', () => {
    expectDomainError(
      () =>
        WalletLedgerEntry.create({
          ...base,
          direction: LedgerDirection.Debit,
          money: brl('10.00'),
          balanceBefore: brl('5.00'),
          balanceAfter: brl('5.00').subtract(brl('10.00')),
        }),
      'LEDGER_NEGATIVE_BALANCE',
    );
  });

  test('aceita lançamento balanceado', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('5.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('5.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });
});
