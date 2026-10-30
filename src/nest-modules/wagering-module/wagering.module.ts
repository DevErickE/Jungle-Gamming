import { Module, type OnApplicationShutdown, type OnApplicationBootstrap, Inject } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Orm } from '../../infrastructure/persistence/orm.ts';
import { CreateWalletUseCase } from '../../application/wallets/create-wallet.use-case.ts';
import { SubmitWagerUseCase } from '../../application/wagering/submit-wager.use-case.ts';
import { PendingReferenceWorker } from '../../application/wagering/pending-reference-worker.ts';
import { ReadModel } from '../../application/queries.ts';
import { ORM_TOKEN } from '../../infrastructure/persistence/tokens.ts';
import { SQS_TOKEN, ensureQueues, queueNamesFromEnv } from '../../infrastructure/messaging/sqs.ts';
import { WagerConsumer } from '../../infrastructure/messaging/wager-consumer.ts';
import { OutboxPublisher } from '../../infrastructure/messaging/outbox-publisher.ts';
import { SqsEventSender } from '../../infrastructure/messaging/sqs-event-sender.ts';
import { log } from '../../infrastructure/logging/logger.ts';
import { WalletsController } from '../../api/controllers/wallets.controller.ts';
import { WageringController } from '../../api/controllers/wagering.controller.ts';
import { CREATE_WALLET, READ_MODEL, SUBMIT_BET, PENDING_WORKER, RECONCILIATION, METRICS, IDENTITY_PORT } from './tokens.ts';
import { AuthGuard } from '../../api/guards/auth.guard.ts';
import { NoOpIdentityAdapter } from '../../infrastructure/auth/no-op-identity.adapter.ts';
import { ReconciliationService } from '../../application/reconciliation.ts';
import { Metrics } from '../../infrastructure/metrics/metrics.ts';
import { MetricsController } from '../../api/controllers/ops/metrics.controller.ts';
import { HttpErrorFilter } from '../../api/filters/http-error.filter.ts';

/**
 * Ciclo de vida dos workers de mensageria: cria as filas, consome `wager-transactions.fifo`
 * e publica a outbox. Desligado com MESSAGING_WORKERS=disabled (útil em testes HTTP).
 */
class MessagingLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private consumer: WagerConsumer | undefined;
  private outboxTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(ORM_TOKEN) private readonly orm: Orm,
    @Inject(SQS_TOKEN) private readonly sqs: SQSClient,
    @Inject(SUBMIT_BET) private readonly useCase: SubmitWagerUseCase,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.MESSAGING_WORKERS === 'disabled') {
      return;
    }
    const maxReceiveCount = Number(process.env.WAGER_MAX_RECEIVE_COUNT ?? 5);
    const queues = await ensureQueues(this.sqs, queueNamesFromEnv(), {
      visibilityTimeoutSeconds: Number(process.env.WAGER_VISIBILITY_TIMEOUT ?? 30),
      maxReceiveCount,
    });

    this.consumer = new WagerConsumer(this.sqs, queues.queueUrl, queues.dlqUrl, this.useCase, { maxReceiveCount }, this.metrics);
    this.consumer.start();

    const publisher = new OutboxPublisher(this.orm, new SqsEventSender(this.sqs, queues.eventsUrl), 50, this.metrics);
    let publishing = false;
    this.outboxTimer = setInterval(() => {
      if (publishing) {
        return;
      }
      publishing = true;
      publisher
        .publishDue()
        .catch((error: unknown) => log('error', 'outbox publisher failed', { error: String(error) }))
        .finally(() => {
          publishing = false;
        });
    }, 1000);
    log('info', 'messaging workers started', { queue: queues.queueUrl });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
    }
    await this.consumer?.stop();
  }
}

/** Liga o worker de referências pendentes, a menos que PENDING_REFERENCE_WORKER=disabled. */
class PendingWorkerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(PENDING_WORKER) private readonly worker: PendingReferenceWorker) {}

  onApplicationBootstrap(): void {
    if (process.env.PENDING_REFERENCE_WORKER !== 'disabled') {
      this.worker.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}

@Module({
  controllers: [WalletsController, WageringController, MetricsController],
  providers: [
    { provide: IDENTITY_PORT, useFactory: () => new NoOpIdentityAdapter() },
    AuthGuard,
    { provide: METRICS, useFactory: () => new Metrics() },
    {
      provide: RECONCILIATION,
      useFactory: (orm: Orm, metrics: Metrics) => new ReconciliationService(orm, metrics),
      inject: [ORM_TOKEN, METRICS],
    },
    {
      provide: CREATE_WALLET,
      useFactory: (orm: Orm) => new CreateWalletUseCase(orm),
      inject: [ORM_TOKEN],
    },
    {
      provide: SUBMIT_BET,
      useFactory: (orm: Orm, metrics: Metrics) => new SubmitWagerUseCase(orm, {}, metrics),
      inject: [ORM_TOKEN, METRICS],
    },
    {
      provide: PENDING_WORKER,
      useFactory: (useCase: SubmitWagerUseCase) => new PendingReferenceWorker(useCase),
      inject: [SUBMIT_BET],
    },
    PendingWorkerLifecycle,
    MessagingLifecycle,
    {
      provide: READ_MODEL,
      useFactory: (orm: Orm) => new ReadModel(orm),
      inject: [ORM_TOKEN],
    },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class WagerHttpModule {}
