import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Metrics } from '../../../infrastructure/metrics/metrics.ts';
import { METRICS } from '../../../nest-modules/wagering-module/tokens.ts';

/** Métricas do processo em formato texto (Prometheus). */
@ApiTags('Observabilidade')
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  @Get()
  @ApiOperation({ summary: 'Contadores do processo no formato Prometheus' })
  @ApiProduces('text/plain')
  @ApiResponse({ status: 200, description: 'Texto com as métricas' })
  @Header('content-type', 'text/plain; version=0.0.4')
  render(): string {
    return this.metrics.render();
  }
}
