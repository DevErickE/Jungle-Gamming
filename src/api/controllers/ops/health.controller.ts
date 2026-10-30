import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Orm } from '../../../infrastructure/persistence/orm.ts';
import { ORM_TOKEN } from '../../../infrastructure/persistence/tokens.ts';
import { SQS_TOKEN } from '../../../infrastructure/messaging/sqs.ts';

// Liveness: o processo está vivo. Readiness: PostgreSQL e SQS alcançáveis.
@ApiTags('Saúde')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(ORM_TOKEN) private readonly orm: Orm,
    @Inject(SQS_TOKEN) private readonly sqs: SQSClient,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness: o processo está vivo' })
  @ApiResponse({ status: 200, description: 'Processo responde' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: PostgreSQL e SQS alcançáveis' })
  @ApiResponse({ status: 200, description: 'Dependências up' })
  @ApiResponse({ status: 503, description: 'Alguma dependência down' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks = {
      database: await this.check(() => this.orm.query('SELECT 1')),
      sqs: await this.check(() => this.sqs.send(new ListQueuesCommand({ MaxResults: 1 }))),
    };
    const ready = Object.values(checks).every((state) => state === 'up');
    res.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks };
  }

  private async check(probe: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await probe();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
