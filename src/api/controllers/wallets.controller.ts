import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateWalletUseCase } from '../../application/wallets/create-wallet.use-case.ts';
import { ReadModel } from '../../application/queries.ts';
import { CREATE_WALLET, READ_MODEL, RECONCILIATION } from '../../nest-modules/wagering-module/tokens.ts';
import { AuthGuard } from '../guards/auth.guard.ts';
import type { ReconciliationService } from '../../application/reconciliation.ts';
import { requireBody, requireMoney, requireUuid } from '../validation.ts';
import { InvalidRequestError } from '../../application/errors.ts';
import { CreateWalletDto } from '../../application/dtos/request/wallets/create-wallet.dto.ts';
import { WalletDto } from '../../application/dtos/response/wallets/wallet.dto.ts';

@ApiTags('Carteiras')
@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET) private readonly createWallet: CreateWalletUseCase,
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
    @Inject(RECONCILIATION) private readonly reconciliation: ReconciliationService,
  ) {}

  /**
   * Compara saldo e ledger. Responde 200 nos dois casos: `consistent` diz o resultado.
   * Divergência é logada e contada em métrica, mas nunca corrigida aqui.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @ApiOperation({ summary: 'Compara saldo guardado com o ledger. Divergência é sinalizada, não corrigida.' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Resultado da conferência. Veja `consistent`.' })
  @ApiResponse({ status: 400, description: 'walletId inválido' })
  @ApiResponse({ status: 404, description: 'Wallet não encontrada' })
  async reconcile(@Param('walletId') walletId: string) {
    return this.reconciliation.reconcile(requireUuid(walletId, 'walletId'));
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Cria a carteira do jogador com saldo inicial' })
  @ApiBody({ type: CreateWalletDto })
  @ApiResponse({ status: 201, type: WalletDto })
  @ApiResponse({ status: 400, description: 'Corpo inválido' })
  @ApiResponse({ status: 409, description: 'Já existe carteira para este playerId e moeda' })
  async create(@Body() body: unknown) {
    const input = requireBody(body);
    return this.createWallet.execute({
      playerId: requireUuid(input.playerId, 'playerId'),
      initialBalance: requireMoney(input.initialBalance, 'initialBalance'),
    });
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Saldo e versão da carteira' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, type: WalletDto })
  @ApiResponse({ status: 404, description: 'Wallet não encontrada' })
  async get(@Param('walletId') walletId: string) {
    return this.readModel.getWallet(requireUuid(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'Extrato paginado da carteira, do lançamento mais recente para o mais antigo' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor opaco devolvido em nextCursor' })
  @ApiQuery({ name: 'limit', required: false, description: 'Entre 1 e 100', example: 50 })
  @ApiResponse({ status: 200, description: 'Lista de lançamentos e nextCursor' })
  @ApiResponse({ status: 400, description: 'Cursor ou limit inválido' })
  @ApiResponse({ status: 404, description: 'Wallet não encontrada' })
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.readModel.listLedger(requireUuid(walletId, 'walletId'), {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: parseLimit(limit) } : {}),
    });
  }
}

function parseLimit(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new InvalidRequestError('limit must be an integer');
  }
  return Number(raw);
}
