import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { DomainError } from '../../domain/shared/domain-error.ts';
import { ApplicationError } from '../../application/errors.ts';
import { parseWagerMessage, MalformedMessageError } from '../../application/messaging/wager-message.ts';
import type { SubmitWagerInput, SubmitWagerUseCase } from '../../application/wagering/submit-wager.use-case.ts';
import { log } from '../logging/logger.ts';
import { Metrics } from '../metrics/metrics.ts';

export const CONSUMER_NAME = 'wager-transactions';

export interface WagerConsumerOptions {
  /** Long polling do SQS, em segundos. */
  waitTimeSeconds?: number;
  maxMessages?: number;
  /** Base do atraso entre tentativas transitórias, em segundos (cresce exponencialmente). */
  backoffBaseSeconds?: number;
  /**
   * Gancho executado depois do commit e antes do ack. Usado pelos testes para simular
   * um processo que morre nesse ponto. Se lançar, a mensagem não é apagada.
   */
  beforeAck?: (messageId: string) => Promise<void>;
  /**
   * Quantos recebimentos a mensagem tem antes de ir para a DLQ. Deve ser igual ao
   * `maxReceiveCount` da fila (WAGER_MAX_RECEIVE_COUNT). Padrão: 5.
   */
  maxReceiveCount?: number;
}

/**
 * Consome `wager-transactions.fifo`.
 *
 * Regras (seção 10 da spec):
 * - mesmo caso de uso da entrada HTTP, com inbox na mesma transação para deduplicar;
 * - ack (DeleteMessage) só depois do commit;
 * - erro de negócio: ack, pois a resposta é terminal;
 * - erro transitório: não apaga e muda a visibilidade com backoff; após maxReceiveCount o SQS move para a DLQ;
 * - mensagem malformada: envia para a DLQ e apaga a original;
 * - SIGTERM: `stop()` deixa o lote em andamento terminar antes de retornar.
 */
export class WagerConsumer {
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
    private readonly useCase: SubmitWagerUseCase,
    private readonly options: WagerConsumerOptions = {},
    private readonly metrics: Metrics = new Metrics(),
  ) {}

  start(): void {
    if (this.loop) {
      return;
    }
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.loop = undefined;
  }

  /** Recebe e processa um lote. Exposto para os testes. Retorna quantas mensagens vieram. */
  async pollOnce(): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: this.options.maxMessages ?? 10,
        WaitTimeSeconds: this.options.waitTimeSeconds ?? 5,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const messages = response.Messages ?? [];
    // Sequencial dentro do lote: preserva a ordem de cada grupo FIFO (uma wallet por grupo).
    for (const message of messages) {
      // Uma falha em uma mensagem não pode impedir as demais do lote: a que falhou volta sozinha.
      try {
        await this.handle(message);
      } catch (error) {
        log('error', 'message handling failed, it will be redelivered', {
          correlationId: message.MessageId,
          error: String(error),
        });
      }
    }
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        log('error', 'consumer poll failed', { error: String(error) });
        await Bun.sleep(1000);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);

    let parsed: ReturnType<typeof parseWagerMessage>;
    try {
      parsed = parseWagerMessage(message.Body ?? '');
    } catch (error) {
      if (error instanceof MalformedMessageError) {
        this.countOutcome('malformed');
        this.metrics.increment('wager_dlq_messages_total', 'Mensagens enviadas para a DLQ pelo consumidor', {
          reason: 'malformed',
        });
        await this.sendToDlq(message, error.message);
        await this.remove(message);
        log('warn', 'malformed message moved to DLQ', {
          correlationId: message.MessageId,
          reason: error.message,
        });
        return;
      }
      throw error;
    }

    let transactionId: string;
    try {
      const result = await this.useCase.execute(parsed.input, {
        inbox: { consumerName: CONSUMER_NAME, messageId: parsed.messageId, payloadHash: parsed.payloadHash },
      });
      transactionId = result.transactionId;
    } catch (error) {
      if (error instanceof ApplicationError || error instanceof DomainError) {
        // Resposta de negócio definitiva (ex.: carteira inexistente): ack, sem reprocessar.
        this.countOutcome('business');
        await this.remove(message);
        log('warn', 'business error, message acknowledged', {
          correlationId: parsed.messageId,
          messageId: parsed.messageId,
          walletId: parsed.input.walletId,
          providerId: parsed.input.providerId,
          externalTransactionId: parsed.input.externalTransactionId,
          code: (error as { code?: string }).code,
        });
        return;
      }
      // Último recebimento permitido: se a falha persistiu, a transação vira FAILED e a mensagem vai para a DLQ.
      const maxReceiveCount = this.options.maxReceiveCount ?? 5;
      if (receiveCount >= maxReceiveCount && (await this.failPermanently(message, parsed.input, parsed.messageId, error))) {
        return;
      }

      // Transitório ou inesperado: não apaga; o SQS reentrega depois da visibilidade.
      const delay = this.backoffSeconds(receiveCount);
      this.countOutcome('transient');
      this.metrics.increment('wager_consumer_retries_total', 'Mensagens reagendadas após falha transitória');
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delay,
        }),
      );
      log('warn', 'transient failure, will retry', {
        correlationId: parsed.messageId,
        messageId: parsed.messageId,
        walletId: parsed.input.walletId,
        providerId: parsed.input.providerId,
        externalTransactionId: parsed.input.externalTransactionId,
        receiveCount,
        retryInSeconds: delay,
        error: String(error),
      });
      return;
    }

    await this.options.beforeAck?.(parsed.messageId);
    await this.remove(message);
    this.countOutcome('processed');
    log('info', 'message processed', {
      correlationId: transactionId,
      transactionId,
      messageId: parsed.messageId,
      walletId: parsed.input.walletId,
      providerId: parsed.input.providerId,
      externalTransactionId: parsed.input.externalTransactionId,
    });
  }

  /**
   * Último recebimento antes da DLQ, com a falha persistindo: registra a transação como FAILED
   * e envia a mensagem para a DLQ. Devolve false quando não consegue registrar (por exemplo,
   * o banco está fora); nesse caso a mensagem segue o caminho normal e o SQS a redireciona.
   */
  private async failPermanently(message: Message, input: SubmitWagerInput, messageId: string, error: unknown): Promise<boolean> {
    let recorded: Awaited<ReturnType<SubmitWagerUseCase['recordInfrastructureFailure']>>;
    try {
      recorded = await this.useCase.recordInfrastructureFailure(input);
    } catch (recordError) {
      log('error', 'could not record failed transaction, the redrive policy will move the message', {
        correlationId: messageId,
        messageId,
        providerId: input.providerId,
        walletId: input.walletId,
        externalTransactionId: input.externalTransactionId,
        error: String(recordError),
      });
      return false;
    }

    if (recorded.outcome === 'recorded') {
      this.metrics.increment('wager_dlq_messages_total', 'Mensagens enviadas para a DLQ pelo consumidor', {
        reason: 'infrastructure',
      });
      await this.sendToDlq(message, `infrastructure failure: ${String(error)}`);
      log('error', 'transaction recorded as FAILED after retries', {
        correlationId: recorded.transactionId,
        transactionId: recorded.transactionId,
        messageId,
        providerId: input.providerId,
        walletId: input.walletId,
        externalTransactionId: input.externalTransactionId,
        error: String(error),
      });
    } else {
      // Outra tentativa já processou ou registrou a transação. O efeito existe, então a mensagem é confirmada.
      log('warn', 'failure ignored: transaction already exists', {
        correlationId: input.idempotencyKey,
        messageId,
        providerId: input.providerId,
        walletId: input.walletId,
        externalTransactionId: input.externalTransactionId,
      });
    }
    await this.remove(message);
    this.countOutcome('failed');
    return true;
  }

  private countOutcome(outcome: 'processed' | 'business' | 'transient' | 'malformed' | 'failed'): void {
    this.metrics.increment('wager_consumer_messages_total', 'Mensagens da fila por resultado', { outcome });
  }

  private backoffSeconds(receiveCount: number): number {
    const base = this.options.backoffBaseSeconds ?? 2;
    return Math.min(base * 2 ** Math.max(receiveCount - 1, 0), 60);
  }

  private async remove(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async sendToDlq(message: Message, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: groupOf(message.Body),
        MessageDeduplicationId: (message.MessageId ?? crypto.randomUUID()).slice(0, 128),
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason.slice(0, 256) } },
      }),
    );
  }
}

/** Grupo FIFO da DLQ: o walletId quando existe, senão um grupo fixo para mensagens sem wallet. */
function groupOf(body: string | undefined): string {
  try {
    const walletId = (JSON.parse(body ?? '{}') as { data?: { walletId?: unknown } }).data?.walletId;
    return typeof walletId === 'string' && walletId.length > 0 ? walletId : 'malformed';
  } catch {
    return 'malformed';
  }
}
