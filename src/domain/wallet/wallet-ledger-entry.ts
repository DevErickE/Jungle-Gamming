import { DomainError } from '../shared/domain-error.ts';
import { Money, type MoneyProps } from '../money/money.ts';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

/**
 * Lançamento imutável do ledger. Não há campos mutáveis nem métodos de transição:
 * a imutabilidade é estrutural. Um lançamento não é atualizado nem removido depois de criado.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Valida a aritmética do lançamento antes de aceitá-lo. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new DomainError('LEDGER_INVALID_AMOUNT', 'ledger entry amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainError('LEDGER_NEGATIVE_BALANCE', 'ledger balances cannot be negative');
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!entry.isBalanced()) {
      throw new DomainError(
        'LEDGER_UNBALANCED',
        `balanceBefore ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} != balanceAfter ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência. Não revalida a aritmética. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter, conforme a direção. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
