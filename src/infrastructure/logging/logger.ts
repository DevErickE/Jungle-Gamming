type Level = 'info' | 'warn' | 'error';

/**
 * Log estruturado em JSON, uma linha por evento. Não registrar payloads financeiros completos:
 * passe apenas identificadores (correlationId, messageId, transactionId, walletId, providerId).
 */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, time: new Date().toISOString(), ...fields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}
