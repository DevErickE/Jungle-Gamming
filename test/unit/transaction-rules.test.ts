import { describe, expect, test } from 'bun:test';
import * as rules from '../../src/domain/wagering/transaction-rules.ts';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry.ts';

describe('tipos suportados', () => {
  test('aceita apenas os cinco tipos da spec; OPENING é interno', () => {
    for (const kind of ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']) {
      expect(rules.isSupportedKind(kind)).toBe(true);
    }
    expect(rules.isSupportedKind('OPENING')).toBe(false);
    expect(rules.isSupportedKind('FOO')).toBe(false);
  });
});

describe('referências', () => {
  test('REFUND e ROLLBACK exigem referência; WIN aceita; BET e LOSS não', () => {
    expect(rules.requiresReference('REFUND')).toBe(true);
    expect(rules.requiresReference('ROLLBACK')).toBe(true);
    expect(rules.requiresReference('WIN')).toBe(false);
    expect(rules.acceptsReference('WIN')).toBe(true);
    expect(rules.acceptsReference('LOSS')).toBe(true);
    expect(rules.acceptsReference('BET')).toBe(false);
  });

  test('REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND; WIN referencia BET', () => {
    expect(rules.allowedReferenceKinds('REFUND')).toEqual(['BET']);
    expect(rules.allowedReferenceKinds('WIN')).toEqual(['BET']);
    expect(rules.allowedReferenceKinds('ROLLBACK')).toEqual(['BET', 'WIN', 'REFUND']);
    expect(rules.allowedReferenceKinds('LOSS')).toEqual(['BET']);
    expect(rules.allowedReferenceKinds('BET')).toEqual([]);
  });

  test('REFUND e ROLLBACK são reversões; WIN e BET não', () => {
    expect(rules.isReversal('REFUND')).toBe(true);
    expect(rules.isReversal('ROLLBACK')).toBe(true);
    expect(rules.isReversal('WIN')).toBe(false);
  });
});

describe('efeito no saldo', () => {
  test('BET debita, WIN credita, REFUND credita', () => {
    expect(rules.balanceDirection('BET')).toBe(LedgerDirection.Debit);
    expect(rules.balanceDirection('WIN')).toBe(LedgerDirection.Credit);
    expect(rules.balanceDirection('REFUND')).toBe(LedgerDirection.Credit);
  });

  test('LOSS não move saldo', () => {
    expect(rules.balanceDirection('LOSS')).toBeNull();
  });

  test('ROLLBACK inverte a referência: reverter BET credita; reverter WIN ou REFUND debita', () => {
    expect(rules.balanceDirection('ROLLBACK', 'BET')).toBe(LedgerDirection.Credit);
    expect(rules.balanceDirection('ROLLBACK', 'WIN')).toBe(LedgerDirection.Debit);
    expect(rules.balanceDirection('ROLLBACK', 'REFUND')).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem o tipo da referência é erro de programação', () => {
    expect(() => rules.balanceDirection('ROLLBACK')).toThrow();
  });
});
