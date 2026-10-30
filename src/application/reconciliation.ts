import type { MoneyProps } from '../domain/money/money.ts';
import type { Orm } from '../infrastructure/persistence/orm.ts';
import { queryOne } from '../infrastructure/persistence/sql.ts';
import { log } from '../infrastructure/logging/logger.ts';
import type { Metrics } from '../infrastructure/metrics/metrics.ts';
import { WalletNotFoundError } from './errors.ts';

export const DIVERGENCE_METRIC = 'wallet_reconciliation_divergences_total';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

interface ReconciliationRow {
  currency: string;
  stored_minor: string;
  calculated_minor: string;
  checked_entries: string;
}

/**
 * Compara o saldo materializado com o saldo reconstruído somando o ledger.
 *
 * A consulta é uma única instrução SQL, então vê um snapshot consistente: cada movimento
 * entra por inteiro (saldo e lançamento) ou não entra. Divergência nunca é corrigida aqui:
 * é logada, contada em métrica e sinalizada na resposta, para investigação.
 */
export class ReconciliationService {
  constructor(
    private readonly orm: Orm,
    private readonly metrics: Metrics,
  ) {}

  async reconcile(walletId: string): Promise<ReconciliationResult> {
    const row = await queryOne<ReconciliationRow>(
      this.orm.manager,
      `SELECT w.currency,
              w.balance_minor AS stored_minor,
              COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END), 0) AS calculated_minor,
              COUNT(e.id) AS checked_entries
         FROM wallets w
         LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id, w.currency, w.balance_minor`,
      [walletId],
    );
    if (!row) {
      throw new WalletNotFoundError(walletId);
    }

    const stored = BigInt(row.stored_minor);
    const calculated = BigInt(row.calculated_minor);
    const consistent = stored === calculated;
    const result: ReconciliationResult = {
      walletId,
      storedBalance: toMoney(stored, row.currency),
      calculatedBalance: toMoney(calculated, row.currency),
      difference: toMoney(stored - calculated, row.currency),
      consistent,
      checkedEntries: Number(row.checked_entries),
    };

    // A wallet é o agregado desta operação, então ela também é o correlationId.
    if (!consistent) {
      this.metrics.increment(DIVERGENCE_METRIC, 'Wallets cuja reconciliação encontrou divergência entre saldo e ledger');
      log('error', 'wallet balance diverges from ledger', {
        correlationId: walletId,
        walletId,
        storedBalance: result.storedBalance.amount,
        calculatedBalance: result.calculatedBalance.amount,
        difference: result.difference.amount,
        checkedEntries: result.checkedEntries,
      });
    } else {
      log('info', 'wallet reconciled', {
        correlationId: walletId,
        walletId,
        checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }
}

/** Formata centavos com sinal (a diferença pode ser negativa). */
function toMoney(minor: bigint, currency: string): MoneyProps {
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  const amount = `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  return { amount, currency };
}
