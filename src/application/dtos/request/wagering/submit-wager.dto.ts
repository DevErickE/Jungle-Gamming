import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyDto } from '../../shared/money.dto.ts';

export const WAGER_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export class SubmitWagerDto {
  @ApiProperty({ example: 'provider-a' })
  providerId!: string;

  @ApiProperty({ example: 'transaction-123', description: 'Id da transação no provedor' })
  externalTransactionId!: string;

  @ApiProperty({ example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', format: 'uuid' })
  playerId!: string;

  @ApiProperty({ example: '0192f291-27dd-7d3f-8071-5f8685deef37', format: 'uuid' })
  walletId!: string;

  @ApiProperty({ example: 'round-987' })
  roundId!: string;

  @ApiProperty({ example: 'fortune-chimp' })
  gameId!: string;

  @ApiProperty({ enum: WAGER_KINDS, example: 'BET' })
  kind!: (typeof WAGER_KINDS)[number];

  @ApiProperty({ type: MoneyDto })
  money!: MoneyDto;

  @ApiPropertyOptional({
    example: 'transaction-100',
    description:
      'Id externo da transação original, do mesmo provedor. Obrigatório em REFUND e ROLLBACK; opcional em WIN e LOSS (aponta para a BET); não aceito em BET.',
  })
  referenceExternalTransactionId?: string | null;
}
