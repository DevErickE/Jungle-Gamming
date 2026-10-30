import { Module } from '@nestjs/common';
import { HealthController } from '../../api/controllers/ops/health.controller.ts';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
