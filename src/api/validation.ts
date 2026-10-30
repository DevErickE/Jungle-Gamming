import type { MoneyProps } from '../domain/money/money.ts';
import { InvalidRequestError } from '../application/errors.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 128;

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidRequestError(`${field} must be a UUID`);
  }
  return value;
}

export function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT) {
    throw new InvalidRequestError(`${field} must be a non-empty string of at most ${MAX_TEXT} characters`);
  }
  return value;
}

export function requireMoney(value: unknown, field: string): MoneyProps {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidRequestError(`${field} must be an object with amount and currency`);
  }
  const { amount, currency } = value as Record<string, unknown>;
  if (typeof amount !== 'string') {
    throw new InvalidRequestError(`${field}.amount must be a decimal string`);
  }
  if (typeof currency !== 'string') {
    throw new InvalidRequestError(`${field}.currency must be a string`);
  }
  // O formato decimal e a moeda são validados de fato pelo domínio (Money.from).
  return { amount, currency };
}

export function requireIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.trim() === '' || value.length > 255) {
    throw new InvalidRequestError('Idempotency-Key header is required (max 255 characters)');
  }
  return value;
}

export function requireBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError('request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}
