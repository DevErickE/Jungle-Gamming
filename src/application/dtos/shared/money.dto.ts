import { ApiProperty } from '@nestjs/swagger';

// Classes de DTO só documentam o contrato no Swagger. A validação fica em api/validation.ts.

export class MoneyDto {
  @ApiProperty({ example: '25.00', description: 'Decimal em string, sempre com 2 casas. Nunca número.' })
  amount!: string;

  @ApiProperty({ example: 'BRL', description: 'Código ISO-4217' })
  currency!: string;
}
