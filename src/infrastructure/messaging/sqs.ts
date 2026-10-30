import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

/** Token de injeção do cliente SQS. */
export const SQS_TOKEN = Symbol('SQS');

export interface QueueNames {
  /** Fila de entrada: transações vindas dos provedores. */
  wager: string;
  /** Dead-letter queue: mensagens que não podem ser processadas. */
  dlq: string;
  /** Fila de saída: eventos publicados pela outbox. */
  events: string;
}

export interface QueueSet {
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

export interface EnsureQueuesOptions {
  visibilityTimeoutSeconds?: number;
  /** Tentativas de recebimento antes de a mensagem ir para a DLQ. */
  maxReceiveCount?: number;
}

export const DEFAULT_QUEUE_NAMES: QueueNames = {
  wager: 'wager-transactions.fifo',
  dlq: 'wager-transactions-dlq.fifo',
  events: 'wager-events.fifo',
};

const DEFAULT_ENDPOINT_REGION = 'us-east-1';

/** Cliente SQS. Com AWS_ENDPOINT_URL aponta para o LocalStack; sem ele, para a AWS real. */
export function createSqsClient(): SQSClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  return new SQSClient({
    region: process.env.AWS_REGION ?? DEFAULT_ENDPOINT_REGION,
    ...(endpoint ? { endpoint } : {}),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

export function queueNamesFromEnv(): QueueNames {
  return {
    wager: process.env.WAGER_QUEUE_NAME ?? DEFAULT_QUEUE_NAMES.wager,
    dlq: process.env.WAGER_DLQ_NAME ?? DEFAULT_QUEUE_NAMES.dlq,
    events: process.env.WAGER_EVENTS_QUEUE_NAME ?? DEFAULT_QUEUE_NAMES.events,
  };
}

/**
 * Cria (ou reaproveita, se já existir com os mesmos atributos) as filas FIFO.
 * A DLQ é criada primeiro, porque a fila de entrada aponta para ela no redrive policy.
 */
export async function ensureQueues(
  client: SQSClient,
  names: QueueNames,
  options: EnsureQueuesOptions = {},
): Promise<QueueSet> {
  const visibility = String(options.visibilityTimeoutSeconds ?? 30);
  const maxReceiveCount = String(options.maxReceiveCount ?? 5);

  const dlqUrl = await createFifoQueue(client, names.dlq, { VisibilityTimeout: visibility });
  const dlqArn = await queueArn(client, dlqUrl);
  const queueUrl = await createFifoQueue(client, names.wager, {
    VisibilityTimeout: visibility,
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount }),
  });
  const eventsUrl = await createFifoQueue(client, names.events, { VisibilityTimeout: visibility });

  return { queueUrl, dlqUrl, eventsUrl };
}

async function createFifoQueue(client: SQSClient, name: string, attributes: Record<string, string>): Promise<string> {
  const result = await client.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }),
  );
  return queueUrlFor(name, result.QueueUrl);
}

async function queueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const result = await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
  const arn = result.Attributes?.QueueArn;
  if (!arn) {
    throw new Error(`queue ${queueUrl} has no ARN`);
  }
  return arn;
}

/**
 * Com endpoint personalizado (LocalStack), a URL devolvida pode apontar para um host que o
 * cliente não alcança. Montamos a URL a partir do endpoint configurado.
 */
function queueUrlFor(name: string, returned: string | undefined): string {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (endpoint) {
    return `${endpoint.replace(/\/$/, '')}/000000000000/${name}`;
  }
  if (!returned) {
    throw new Error(`no queue URL returned for ${name}`);
  }
  return returned;
}
