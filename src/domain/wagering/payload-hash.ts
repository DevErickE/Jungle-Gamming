import { createHash } from 'node:crypto';

/** Campos de negócio que entram no hash. Header e metadados de transporte ficam de fora. */
export interface BusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId: string | null;
}

/**
 * Hash SHA-256 de um JSON canônico: chaves ordenadas recursivamente, sem espaços.
 * Mesmo payload em qualquer ordem de chaves gera o mesmo hash.
 */
export function hashBusinessPayload(payload: BusinessPayload): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}
