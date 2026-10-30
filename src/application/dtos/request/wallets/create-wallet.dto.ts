import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../shared/money.dto.ts';

export class CreateWalletDto {
  @ApiProperty({ example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', format: 'uuid' })
  playerId!: string;

  @ApiProperty({ type: MoneyDto })
  initialBalance!: MoneyDto;
}
