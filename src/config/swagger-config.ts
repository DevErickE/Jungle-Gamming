import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Swagger UI em /docs e contrato OpenAPI em /openapi-json.
 * Desligado em NODE_ENV=production, como no core-back: a superfície da API não fica exposta em produção.
 * A autenticação não aparece aqui porque o AuthGuard ainda é um ponto de extensão sem efeito (ARCHITECTURE.md, seção 10).
 */
export function applySwaggerConfig(app: INestApplication): void {
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  const config = new DocumentBuilder()
    .setTitle('Carteira de apostas')
    .setDescription('Processamento de transações de apostas de múltiplos provedores, com ledger e idempotência.')
    .setVersion('0.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, document, {
    explorer: true,
    jsonDocumentUrl: 'openapi-json',
    swaggerOptions: {
      docExpansion: 'none',
      defaultModelsExpandDepth: -1,
    },
  });
}
