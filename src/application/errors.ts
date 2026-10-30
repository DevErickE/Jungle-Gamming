/**
 * Erros de aplicação. A camada HTTP traduz cada um para um status code distinto
 * (ver mapeamento em ARCHITECTURE.md).
 */
export class ApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(playerId: string, currency: string) {
    super('WALLET_ALREADY_EXISTS', `player ${playerId} already has a ${currency} wallet`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor(reference: string) {
    super('TRANSACTION_NOT_FOUND', `transaction ${reference} not found`);
  }
}

/** Mesma idempotency key com payload diferente, ou mesma transação externa com outra key. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(idempotencyKey: string) {
    super('IDEMPOTENCY_CONFLICT', `idempotency key ${idempotencyKey} was used with a different payload`);
  }
}

/** Payload que não bate com a wallet (jogador ou moeda). Não é gravado. */
export class InvalidTransactionError extends ApplicationError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

export class UnsupportedTransactionKindError extends ApplicationError {
  constructor(kind: string) {
    super('UNSUPPORTED_TRANSACTION_KIND', `transaction kind ${kind} is not supported`);
  }
}

/** Requisição malformada: campo ausente, formato inválido ou cursor corrompido. */
export class InvalidRequestError extends ApplicationError {
  constructor(message: string) {
    super('INVALID_REQUEST', message);
  }
}
