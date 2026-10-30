import { createHash } from 'node:crypto';
import { Money } from '../../domain/money/money.ts';
import { canonicalJson } from '../../domain/wagering/payload-hash.ts';
import type { SubmitWagerInput } from '../wagering/submit-wager.use-case.ts';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/** Mensagem malformada: não há o que reprocessar. Vai para a DLQ. */
export class MalformedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedMessageError';
  }
}

export interface ParsedWagerMessage {
  messageId: string;
  occurredAt: string;
  /** Campos de negócio já validados, prontos para o caso de uso. */
  input: SubmitWagerInput;
  /** Hash do payload de negócio, gravado na inbox. */
  payloadHash: string;
}

/**
 * Valida o envelope da seção 10 da spec. Erro aqui é permanente (DLQ).
 * Valores de negócio inválidos (ex.: amount com 3 casas) também são permanentes.
 */
export function parseWagerMessage(body: string): ParsedWagerMessage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new MalformedMessageError('body is not valid JSON');
  }
  const message = asObject(envelope, 'message');
  if (message.type !== WAGER_MESSAGE_TYPE) {
    throw new MalformedMessageError(`unexpected message type: ${String(message.type)}`);
  }
  const messageId = requiredText(message.messageId, 'messageId');
  const occurredAt = requiredText(message.occurredAt, 'occurredAt');

  const data = asObject(message.data, 'data');
  const money = asObject(data.money, 'data.money');
  const amount = requiredText(money.amount, 'data.money.amount');
  const currency = requiredText(money.currency, 'data.money.currency');
  try {
    Money.from({ amount, currency });
  } catch (error) {
    throw new MalformedMessageError(`invalid money: ${(error as Error).message}`);
  }

  const referenceExternalTransactionId =
    data.referenceExternalTransactionId === undefined || data.referenceExternalTransactionId === null
      ? null
      : requiredText(data.referenceExternalTransactionId, 'data.referenceExternalTransactionId');

  const input: SubmitWagerInput = {
    idempotencyKey: requiredText(data.idempotencyKey, 'data.idempotencyKey'),
    providerId: requiredText(data.providerId, 'data.providerId'),
    externalTransactionId: requiredText(data.externalTransactionId, 'data.externalTransactionId'),
    playerId: requiredText(data.playerId, 'data.playerId'),
    walletId: requiredText(data.walletId, 'data.walletId'),
    roundId: requiredText(data.roundId, 'data.roundId'),
    gameId: requiredText(data.gameId, 'data.gameId'),
    kind: requiredText(data.kind, 'data.kind'),
    money: { amount, currency },
    referenceExternalTransactionId,
  };

  return {
    messageId,
    occurredAt,
    input,
    payloadHash: createHash('sha256').update(canonicalJson(data)).digest('hex'),
  };
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedMessageError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MalformedMessageError(`${field} must be a non-empty string`);
  }
  return value;
}
