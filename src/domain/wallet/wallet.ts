import { DomainError } from '../shared/domain-error.ts';
import { Money, type MoneyProps } from '../money/money.ts';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.ts';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  /** Saldo inicial. Quando maior que zero, gera o lançamento CREDIT de abertura. */
  initialBalance: Money;
  openingEntryId: string;
  openingTransactionId: string;
  at: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  /** null quando o saldo inicial é zero (não há movimentação). */
  openingEntry: WalletLedgerEntry | null;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  amount: Money;
  at: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate Root. Toda alteração de saldo produz exatamente um lançamento no ledger,
 * e o saldo nunca fica negativo. A concorrência entre instâncias NÃO é resolvida aqui:
 * ela é responsabilidade da camada de persistência (lock por wallet).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Cria a wallet. version começa em 1, já refletindo o saldo inicial. */
  static open(props: OpenWalletProps): OpenWalletResult {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new DomainError('WALLET_INVALID_AMOUNT', 'initial balance cannot be negative');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      props.at,
      props.at,
    );

    if (initialBalance.isZero()) {
      return { wallet, openingEntry: null };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência. Não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Débito: falha se o saldo for insuficiente. Não altera nada quando falha. */
  debit(movement: MovementProps): WalletLedgerEntry {
    this.assertMovementAllowed(movement.amount);
    if (this._balance.isLessThan(movement.amount)) {
      throw new DomainError(
        'WALLET_INSUFFICIENT_FUNDS',
        `balance ${this._balance.toString()} is less than ${movement.amount.toString()}`,
      );
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  /** Crédito. */
  credit(movement: MovementProps): WalletLedgerEntry {
    this.assertMovementAllowed(movement.amount);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, movement: MovementProps): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(movement.amount)
        : balanceBefore.add(movement.amount);

    // Criar o lançamento primeiro: se a aritmética falhar, o estado da wallet não muda.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.amount,
      balanceBefore,
      balanceAfter,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertMovementAllowed(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new DomainError(
        'WALLET_CURRENCY_MISMATCH',
        `operation currency ${amount.currency} differs from wallet currency ${this.currency}`,
      );
    }
    if (!amount.isPositive()) {
      throw new DomainError('WALLET_INVALID_AMOUNT', 'movement amount must be positive');
    }
  }
}
