import type { EventEnvelope, IntegrationEvent } from './integration-event.ts';

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: EventEnvelope<unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

/**
 * Evento aguardando publicação. Vive na mesma transação da mudança de estado que o gerou,
 * então a mudança e o evento são gravados juntos ou não são.
 *
 * Ciclo de vida: pendente -> publicado (final). Cada falha reagenda a próxima tentativa
 * com backoff exponencial, limitado a 60 segundos.
 */
export class OutboxMessage {
  private constructor(private readonly fields: OutboxMessageState) {}

  static fromEvent(event: IntegrationEvent<object>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: envelope,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: null,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state });
  }

  get id(): string {
    return this.fields.id;
  }
  /** Chave do grupo FIFO: todos os eventos de um agregado saem em ordem. */
  get groupId(): string {
    return this.fields.aggregateId;
  }
  get payload(): EventEnvelope<unknown> {
    return this.fields.payload;
  }
  get attempts(): number {
    return this.fields.attempts;
  }
  get isPublished(): boolean {
    return this.fields.publishedAt !== null;
  }

  isDue(now: Date): boolean {
    return !this.isPublished && this.fields.nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (this.isPublished) {
      throw new Error(`outbox message ${this.fields.id} was already published`);
    }
    this.fields.publishedAt = at;
  }

  /** Registra uma falha e agenda a próxima tentativa. */
  markFailed(at: Date): void {
    if (this.isPublished) {
      throw new Error(`outbox message ${this.fields.id} was already published`);
    }
    this.fields.attempts += 1;
    this.fields.nextAttemptAt = new Date(at.getTime() + backoffMs(this.fields.attempts));
  }

  toState(): OutboxMessageState {
    return { ...this.fields };
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}
