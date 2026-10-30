import { DomainError } from '../shared/domain-error.ts';

export interface MoneyProps {
  /** Decimal em string, ex.: "25.00". Sem sinal, sem notação científica. */
  amount: string;
  /** ISO-4217, ex.: "BRL". */
  currency: string;
}

/**
 * Aceita apenas: dígitos, opcionalmente seguidos de "." com 1 ou 2 dígitos.
 * Rejeita sinal, espaços, notação científica, NaN, Infinity, string vazia e mais de 2 casas.
 */
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor armazenado em centavos (bigint). Aritmética inteira é exata,
 * então não há erro de arredondamento. Nunca usamos number ou float para dinheiro.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    assertValidCurrency(props.currency);
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new DomainError('MONEY_INVALID_AMOUNT', `invalid amount: ${String(props.amount)}`);
    }
    return new Money(parseMinorUnits(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    assertValidCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const sign = this.minorUnits < 0n ? '-' : '';
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const integer = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, '0');
    return `${sign}${integer}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        'MONEY_CURRENCY_MISMATCH',
        `currency mismatch: ${this.currency} vs ${other.currency}`,
      );
    }
  }
}

function assertValidCurrency(currency: string): void {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new DomainError('MONEY_INVALID_CURRENCY', `invalid currency: ${currency}`);
  }
}

function parseMinorUnits(amount: string): bigint {
  const [integerPart = '0', fractionPart = ''] = amount.split('.');
  // Normaliza para exatamente 2 casas: "25.5" vira 2550 centavos.
  const fraction = (fractionPart + '00').slice(0, 2);
  return BigInt(integerPart) * 100n + BigInt(fraction);
}
