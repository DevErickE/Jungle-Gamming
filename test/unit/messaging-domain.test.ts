import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/domain/messaging/inbox-message.ts';
import { IntegrationEvent, type EventContext } from '../../src/domain/messaging/integration-event.ts';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.ts';

class SampleEvent extends IntegrationEvent<{ value: number }> {
  readonly eventType = 'SampleEvent';
  readonly version = 1;

  constructor(context: EventContext, aggregateId: string, value: number) {
    super(context, aggregateId, { value });
  }
}

const at = new Date('2026-10-28T12:00:00.000Z');

describe('OutboxMessage', () => {
  test('nasce pendente e vence no instante do evento', () => {
    const message = OutboxMessage.fromEvent(new SampleEvent({ eventId: 'evt-1', occurredAt: at }, 'agg-1', 7));
    expect(message.isPublished).toBe(false);
    expect(message.isDue(at)).toBe(true);
    expect(message.groupId).toBe('agg-1');
    expect(message.payload.data).toEqual({ value: 7 });
  });

  test('publicada uma vez, não é mais devida e não aceita nova publicação', () => {
    const message = OutboxMessage.fromEvent(new SampleEvent({ eventId: 'evt-1', occurredAt: at }, 'agg-1', 7));
    message.markPublished(at);
    expect(message.isPublished).toBe(true);
    expect(message.isDue(new Date(at.getTime() + 60_000))).toBe(false);
    expect(() => message.markPublished(at)).toThrow('already published');
  });

  test('falha reagenda com backoff exponencial, limitado a 60 segundos', () => {
    const message = OutboxMessage.fromEvent(new SampleEvent({ eventId: 'evt-1', occurredAt: at }, 'agg-1', 7));

    message.markFailed(at);
    expect(message.attempts).toBe(1);
    expect(message.isDue(new Date(at.getTime() + 1999))).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 2000))).toBe(true);

    for (let i = 0; i < 10; i += 1) {
      message.markFailed(at);
    }
    expect(message.isDue(new Date(at.getTime() + 59_999))).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 60_000))).toBe(true);
  });
});

describe('causationId no envelope', () => {
  test('aparece quando há causa e fica de fora quando não há', () => {
    const caused = new SampleEvent({ eventId: 'evt-c', occurredAt: at, causationId: 'msg-1' }, 'agg-1', 1);
    const plain = new SampleEvent({ eventId: 'evt-p', occurredAt: at }, 'agg-1', 1);

    expect(caused.toJSON().causationId).toBe('msg-1');
    expect(plain.toJSON()).not.toHaveProperty('causationId');
  });
});

describe('InboxMessage', () => {
  test('recebida e depois processada, uma única vez', () => {
    const message = InboxMessage.receive({ consumerName: 'wager-transactions', messageId: 'm-1', payloadHash: 'h', at });
    expect(message.isProcessed).toBe(false);
    message.markProcessed(at);
    expect(message.isProcessed).toBe(true);
    expect(() => message.markProcessed(at)).toThrow('already processed');
  });
});
