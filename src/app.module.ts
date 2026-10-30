import { Module } from '@nestjs/common';
import { HealthModule } from './nest-modules/health-module/health.module.ts';
import { WagerHttpModule } from './nest-modules/wagering-module/wagering.module.ts';
import { PersistenceModule } from './nest-modules/persistence-module/persistence.module.ts';

@Module({
  imports: [PersistenceModule, HealthModule, WagerHttpModule],
})
export class AppModule {}
