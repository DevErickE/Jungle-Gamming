import type { Orm } from '../persistence/orm.ts';
import { OutboxMessage, type OutboxMessageState } from '../../domain/messaging/outbox-message.ts';
import type { EventEnvelope } from '../../domain/messaging/integration-event.ts';
import { queryAll, runSql } from '../persistence/sql.ts';
import { log } from '../logging/logger.ts';
import { Metrics } from '../metrics/metrics.ts';

/** Destino dos eventos. Implementado com SQS FIFO; separado para testes e troca futura. */
export interface EventSender {
  send(event: { id: string; groupId: string; body: string }): Promise<void>;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: EventEnvelope<unknown>;
  occurred_at: Date;
  next_attempt_at: Date;
  attempts: number;
  published_at: Date | null;
}

/**
 * Publica as mensagens pendentes da outbox.
 *
 * Vários publishers podem rodar ao mesmo tempo: `FOR UPDATE SKIP LOCKED` faz cada um
 * pegar um lote diferente, sem esperar pelos outros. Quem falha ao publicar é reagendado
 * com backoff exponencial, sem travar os demais.
 *
 * Entrega at-least-once: se o processo morrer depois de publicar e antes de marcar como
 * publicado, o evento sai de novo. O `id` do evento é a MessageDeduplicationId da FIFO,
 * então o SQS descarta a repetição dentro da janela de deduplicação (5 minutos).
 */
export class OutboxPublisher {
  constructor(
    private readonly orm: Orm,
    private readonly sender: EventSender,
    private readonly batchSize = 50,
    private readonly metrics: Metrics = new Metrics(),
  ) {}

  /** Publica um lote de eventos vencidos. Retorna quantos foram publicados. */
  async publishDue(now: Date = new Date()): Promise<number> {
    const published = await this.orm.transaction(async (tx) => {
      const rows = await queryAll<OutboxRow>(
        tx,
        `SELECT id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, attempts, published_at
           FROM outbox_messages
          WHERE published_at IS NULL AND next_attempt_at <= ?
          ORDER BY occurred_at
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [now, this.batchSize],
      );

      let published = 0;
      for (const row of rows) {
        const message = OutboxMessage.rehydrate(toState(row));
        if (!message.isDue(now)) {
          continue;
        }
        try {
          await this.sender.send({
            id: message.id,
            groupId: message.groupId,
            body: JSON.stringify(message.payload),
          });
          message.markPublished(now);
          await runSql(tx, 'UPDATE outbox_messages SET published_at = ? WHERE id = ?', [now, message.id]);
          log('info', 'outbox event published', eventFields(message));
          published += 1;
        } catch (error) {
          message.markFailed(now);
          const state = message.toState();
          await runSql(tx, 'UPDATE outbox_messages SET attempts = ?, next_attempt_at = ? WHERE id = ?', [
            state.attempts,
            state.nextAttemptAt,
            message.id,
          ]);
          log('warn', 'outbox publish failed, will retry', { ...eventFields(message), error: String(error) });
        }
      }
      return published;
    });

    if (published > 0) {
      this.metrics.increment('outbox_events_published_total', 'Eventos da outbox publicados com sucesso', {}, published);
    }
    this.metrics.gauge('outbox_lag_seconds', 'Idade do evento pendente mais antigo da outbox', (await this.lagMs(now)) / 1000);
    return published;
  }

  /** Idade, em ms, do evento pendente mais antigo. Zero quando não há pendências. */
  async lagMs(now: Date = new Date()): Promise<number> {
    const rows = await queryAll<{ oldest: Date | null }>(
      this.orm.manager,
      'SELECT MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL',
    );
    const oldest = rows[0]?.oldest;
    return oldest ? Math.max(0, now.getTime() - new Date(oldest).getTime()) : 0;
  }
}

/** Campos de rastreio do evento. O transactionId só existe nos eventos de transação. */
function eventFields(message: OutboxMessage): Record<string, unknown> {
  const data = message.payload.data as { transactionId?: string };
  return {
    eventId: message.id,
    eventType: message.payload.eventType,
    correlationId: message.payload.correlationId,
    transactionId: data.transactionId,
  };
}

function toState(row: OutboxRow): OutboxMessageState {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    publishedAt: row.published_at ? new Date(row.published_at) : null,
  };
}
