import { DomainError } from '../../domain/shared/domain-error.ts';
import { isTransientError } from '../../application/transient-errors.ts';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidRequestError,
  InvalidTransactionError,
  TransactionNotFoundError,
  UnsupportedTransactionKindError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors.ts';

export interface HttpError {
  status: number;
  code: string;
  message: string;
}

/**
 * Mapeamento único de erros para HTTP. Status distintos para:
 * - payload inválido (400)
 * - recurso inexistente (404)
 * - conflito de idempotência ou de criação (409)
 * - regra de negócio (422, com failureCode no corpo)
 * - falha transitória de infraestrutura (503, o provedor pode reenviar)
 * - erro inesperado (500)
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return { status: 404, code: error.code, message: error.message };
  }
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof InvalidRequestError) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof InvalidTransactionError || error instanceof UnsupportedTransactionKindError) {
    return { status: 422, code: error.code, message: error.message };
  }
  if (error instanceof DomainError) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof ApplicationError) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (isTransientError(error)) {
    return { status: 503, code: 'TEMPORARILY_UNAVAILABLE', message: 'database is temporarily unavailable' };
  }
  if (isInvalidInputError(error)) {
    return { status: 400, code: 'INVALID_REQUEST', message: 'invalid identifier format' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'unexpected error' };
}

/** Identificador malformado (ex.: UUID inválido em uma consulta). */
function isInvalidInputError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '22P02';
}
