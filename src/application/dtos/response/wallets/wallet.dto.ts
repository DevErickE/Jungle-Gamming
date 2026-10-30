import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../shared/money.dto.ts';

export class WalletDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty({ type: MoneyDto })
  balance!: MoneyDto;

  @ApiProperty({ example: 1, description: 'Inicia em 1 e cresce a cada alteração de saldo' })
  version!: number;
}
