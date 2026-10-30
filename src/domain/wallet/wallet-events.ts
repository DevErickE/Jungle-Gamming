import { IntegrationEvent, type EventContext } from '../messaging/integration-event.ts';
import type { MoneyProps } from '../money/money.ts';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry.ts';
import type { Wallet } from './wallet.ts';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  /** Emitido uma vez por lançamento, já com a versão da wallet depois da alteração. */
  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(context, wallet.id, {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    });
  }
}
