import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyDto } from '../../shared/money.dto.ts';

export const WAGER_STATUSES = ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'] as const;

export class WagerResultDto {
  @ApiProperty({ example: '0192f298-345e-7e38-af88-e43f851a819d', format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: WAGER_STATUSES })
  status!: (typeof WAGER_STATUSES)[number];

  @ApiProperty({ type: MoneyDto, description: 'Saldo da wallet depois da operação' })
  balance!: MoneyDto;

  @ApiPropertyOptional({
    example: 'WALLET_INSUFFICIENT_FUNDS',
    description: 'Presente quando REJECTED. Código estável, legível por máquina.',
  })
  failureCode?: string;

  @ApiProperty({ example: false, description: 'true quando a mesma Idempotency-Key já tinha sido processada' })
  idempotentReplay!: boolean;
}
