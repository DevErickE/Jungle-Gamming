import { LedgerDirection } from '../wallet/wallet-ledger-entry.ts';

/**
 * Regras puras das transações de aposta (seção 7 da spec). Não dependem de banco.
 */
export const SUPPORTED_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof SUPPORTED_KINDS)[number];

export function isSupportedKind(value: string): value is WagerKind {
  return (SUPPORTED_KINDS as readonly string[]).includes(value);
}

/**
 * Referência é opcional em WIN e LOSS, e obrigatória em REFUND e ROLLBACK. Só a BET não aceita:
 * ela é a origem da rodada e não aponta para nada.
 */
export function acceptsReference(kind: WagerKind): boolean {
  return kind !== 'BET';
}

export function requiresReference(kind: WagerKind): boolean {
  return kind === 'REFUND' || kind === 'ROLLBACK';
}

/**
 * Tipos de transação que cada tipo pode referenciar. WIN, LOSS e REFUND apontam para uma BET.
 * ROLLBACK aponta para BET, WIN ou REFUND.
 */
export function allowedReferenceKinds(kind: WagerKind): readonly WagerKind[] {
  switch (kind) {
    case 'WIN':
    case 'LOSS':
    case 'REFUND':
      return ['BET'];
    case 'ROLLBACK':
      return ['BET', 'WIN', 'REFUND'];
    default:
      return [];
  }
}

/** REFUND e ROLLBACK revertem uma transação anterior. */
export function isReversal(kind: WagerKind): boolean {
  return kind === 'REFUND' || kind === 'ROLLBACK';
}

/** WIN e LOSS são o desfecho de uma BET. Uma BET tem no máximo um desfecho. */
export function isOutcome(kind: WagerKind): boolean {
  return kind === 'WIN' || kind === 'LOSS';
}

/**
 * Direção do lançamento no saldo, ou null quando a transação não move saldo (LOSS).
 * ROLLBACK inverte a referência: reverter uma BET credita, reverter WIN ou REFUND debita.
 */
export function balanceDirection(kind: WagerKind, referenceKind?: WagerKind): LedgerDirection | null {
  switch (kind) {
    case 'BET':
      return LedgerDirection.Debit;
    case 'WIN':
    case 'REFUND':
      return LedgerDirection.Credit;
    case 'ROLLBACK':
      if (referenceKind === undefined) {
        throw new Error('ROLLBACK requires the kind of its reference');
      }
      return referenceKind === 'BET' ? LedgerDirection.Credit : LedgerDirection.Debit;
    case 'LOSS':
      return null;
  }
}
