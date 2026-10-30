import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money.ts';
import { DomainError } from '../../src/domain/shared/domain-error.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  test('aceita valor com escala 2 e serializa igual', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('normaliza para exatamente 2 casas decimais', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('0.1').toString()).toBe('0.10');
  });

  test('preserva valores grandes sem perda de precisão', () => {
    expect(brl('99999999999999999999.99').toString()).toBe('99999999999999999999.99');
  });

  test.each([
    ['string vazia', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica', '1e3'],
    ['mais de 2 casas', '1.234'],
    ['valor negativo', '-1.00'],
    ['espaços', ' 1.00'],
    ['separador decimal com vírgula', '1,00'],
    ['texto', 'abc'],
    ['ponto sem fração', '1.'],
    ['sem parte inteira', '.5'],
  ])('rejeita entrada inválida: %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(DomainError);
  });

  test('rejeita amount que não é string', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      DomainError,
    );
  });

  test.each(['br', 'BRLX', 'brl', ''])('rejeita moeda inválida: "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(DomainError);
  });
});

describe('Money aritmética', () => {
  test('soma sem erro de ponto flutuante (0.10 + 0.20 = 0.30)', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('subtração pode resultar em negativo (uso interno de cálculo)', () => {
    const result = brl('10.00').subtract(brl('25.00'));
    expect(result.toString()).toBe('-15.00');
    expect(result.isNegative()).toBe(true);
  });

  test('negate inverte o sinal', () => {
    expect(brl('12.34').negate().toString()).toBe('-12.34');
    expect(brl('12.34').negate().negate().equals(brl('12.34'))).toBe(true);
  });

  test('zero', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.toString()).toBe('0.00');
  });
});

describe('Money comparações', () => {
  test('isPositive, isNegative e isZero', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.00').isNegative()).toBe(false);
  });

  test('isLessThan', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
  });

  test('equals compara valor e moeda', () => {
    expect(brl('5.00').equals(brl('5'))).toBe(true);
    expect(brl('5.00').equals(Money.from({ amount: '5.00', currency: 'USD' }))).toBe(false);
  });
});

describe('Money moeda', () => {
  test('operações entre moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(DomainError);
    expect(() => brl('1.00').subtract(usd)).toThrow(DomainError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(DomainError);
  });

  test('código do erro de moeda é estável', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    try {
      brl('1.00').add(usd);
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect((error as DomainError).code).toBe('MONEY_CURRENCY_MISMATCH');
    }
  });
});

describe('Money imutabilidade', () => {
  test('operações retornam nova instância e não alteram a original', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));
    expect(sum).not.toBe(original);
    expect(original.toString()).toBe('10.00');
  });
});
