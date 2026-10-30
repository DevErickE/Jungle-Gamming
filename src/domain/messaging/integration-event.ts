/** Dados comuns a todo evento de integração, preenchidos pelo ponto que emite o evento. */
export interface EventContext {
  eventId: string;
  /** Por padrão, o id do agregado: todos os eventos de uma transação ficam no mesmo fluxo. */
  correlationId?: string;
  /** Id do que causou o evento, por exemplo a mensagem recebida da fila. Opcional. */
  causationId?: string;
  occurredAt: Date;
}

/** Envelope serializado, o formato que a outbox guarda e o SQS entrega. */
export interface EventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Base de todos os eventos publicados. Cada subclasse define seu nome e sua versão,
 * então o nome do evento fica no tipo, e não numa string espalhada pelo código.
 *
 * `toJSON()` produz o envelope da seção 11 da spec. O `JSON.stringify` do objeto usa
 * esse método, então a outbox grava exatamente o que o consumidor vai receber.
 */
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;

  protected constructor(
    context: EventContext,
    aggregateId: string,
    protected readonly data: T,
  ) {
    this.eventId = context.eventId;
    this.aggregateId = aggregateId;
    this.correlationId = context.correlationId ?? aggregateId;
    this.causationId = context.causationId;
    this.occurredAt = context.occurredAt;
  }

  toJSON(): EventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      // Só aparece quando há causa: eventos da API continuam com o mesmo formato de antes.
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
