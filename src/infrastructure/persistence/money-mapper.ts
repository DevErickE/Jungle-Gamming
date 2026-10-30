import { Money, type MoneyProps } from '../../domain/money/money.ts';

/**
 * O banco guarda o valor em centavos (bigint). O driver devolve bigint como string,
 * então a conversão para Money passa por aqui.
 */
export function moneyFromMinorUnits(minor: string | bigint, currency: string): Money {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const integer = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  // Money.from só aceita não negativos; saldos persistidos nunca são negativos.
  if (negative) {
    throw new Error(`persisted minor units must not be negative: ${minor}`);
  }
  return Money.from({ amount: `${integer}.${fraction}`, currency });
}

export function minorUnitsOf(money: Money): bigint {
  const props: MoneyProps = money.toJSON();
  const [integer = '0', fraction = ''] = props.amount.split('.');
  return BigInt(integer) * 100n + BigInt((fraction + '00').slice(0, 2));
}
