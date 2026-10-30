/**
 * Processo filho usado pelo teste de morte do publicador. Ele publica a outbox e, logo depois
 * de enviar o primeiro evento para o SQS, morre com SIGKILL. A transação que marcaria o evento
 * como publicado nunca é confirmada, então o banco desfaz a marcação.
 *
 *   bun test/fixtures/outbox-publisher-worker.ts <eventsQueueUrl>
 */
import { createOrm } from '../../src/infrastructure/persistence/orm.ts';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.ts';
import { OutboxPublisher, type EventSender } from '../../src/infrastructure/messaging/outbox-publisher.ts';
import { SqsEventSender } from '../../src/infrastructure/messaging/sqs-event-sender.ts';
import { TEST_DATABASE_URL } from '../helpers/database.ts';

const [eventsQueueUrl] = process.argv.slice(2);
if (!eventsQueueUrl) {
  console.error('uso: outbox-publisher-worker.ts <eventsQueueUrl>');
  process.exit(1);
}

const orm = await createOrm(process.env.DATABASE_URL ?? TEST_DATABASE_URL);
const sqs = createSqsClient();
const real = new SqsEventSender(sqs, eventsQueueUrl);

const dyingSender: EventSender = {
  async send(event) {
    await real.send(event);
    // A mensagem já está no SQS. O processo morre antes de a transação ser confirmada.
    process.kill(process.pid, 'SIGKILL');
  },
};

await new OutboxPublisher(orm, dyingSender).publishDue();
