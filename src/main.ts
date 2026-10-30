import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { applySwaggerConfig } from './config/swagger-config.ts';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  applySwaggerConfig(app);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(JSON.stringify({ level: 'info', message: 'server listening', port }));
}

void bootstrap();
