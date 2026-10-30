import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createOrm, type Orm } from '../../infrastructure/persistence/orm.ts';
import { ORM_TOKEN } from '../../infrastructure/persistence/tokens.ts';
import { SQS_TOKEN, createSqsClient } from '../../infrastructure/messaging/sqs.ts';

const DEFAULT_DATABASE_URL = 'postgres://wallet:wallet@127.0.0.1:5432/wallet';

/** Fecha as conexões na parada da aplicação. */
class ConnectionsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM_TOKEN) private readonly orm: Orm,
    @Inject(SQS_TOKEN) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.destroy();
  }
}

/** Conexões compartilhadas (PostgreSQL e SQS), disponíveis em todos os módulos. */
@Global()
@Module({
  providers: [
    {
      provide: ORM_TOKEN,
      useFactory: () => createOrm(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL),
    },
    { provide: SQS_TOKEN, useFactory: () => createSqsClient() },
    ConnectionsLifecycle,
  ],
  exports: [ORM_TOKEN, SQS_TOKEN],
})
export class PersistenceModule {}
