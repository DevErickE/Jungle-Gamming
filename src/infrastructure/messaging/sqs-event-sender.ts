import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventSender } from './outbox-publisher.ts';

/** Publica eventos na fila FIFO de saída. Grupo = agregado, deduplicação = id do evento. */
export class SqsEventSender implements EventSender {
  constructor(
    private readonly sqs: SQSClient,
    private readonly eventsUrl: string,
  ) {}

  async send(event: { id: string; groupId: string; body: string }): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.eventsUrl,
        MessageBody: event.body,
        MessageGroupId: event.groupId,
        MessageDeduplicationId: event.id,
      }),
    );
  }
}
