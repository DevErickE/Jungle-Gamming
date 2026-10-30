/**
 * Erros de infraestrutura que valem nova tentativa: conexão perdida, servidor indisponível,
 * serialização concorrente (40001) e deadlock (40P01). Erros de negócio não entram aqui.
 */
const TRANSIENT_NODE_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'];
const TRANSIENT_SQLSTATES = ['57P01', '57P03', '53300', '40001', '40P01'];

export function isTransientError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') {
    return false;
  }
  return TRANSIENT_NODE_CODES.includes(code) || TRANSIENT_SQLSTATES.includes(code) || code.startsWith('08');
}
