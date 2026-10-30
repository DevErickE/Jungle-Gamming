import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard.ts';
import { SubmitWagerDto } from '../../application/dtos/request/wagering/submit-wager.dto.ts';
import { WagerResultDto } from '../../application/dtos/response/wagering/wager-result.dto.ts';
import type { Response } from 'express';
import { SubmitWagerUseCase } from '../../application/wagering/submit-wager.use-case.ts';
import { ReadModel } from '../../application/queries.ts';
import { SUBMIT_BET, READ_MODEL } from '../../nest-modules/wagering-module/tokens.ts';
import { requireBody, requireIdempotencyKey, requireMoney, requireText, requireUuid } from '../validation.ts';

@ApiTags('Transações de aposta')
@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(SUBMIT_BET) private readonly submitWager: SubmitWagerUseCase,
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
  ) {}

  /**
   * Resposta: 200 para PROCESSED (inclusive replay, com idempotentReplay=true), 202 para
   * PENDING_REFERENCE (a referência ainda não chegou) e 422 para REJECTED por regra de
   * negócio, com failureCode no corpo.
   */
  @Post('wagering/transactions')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submete BET, WIN, LOSS, REFUND ou ROLLBACK',
    description:
      'Header Idempotency-Key obrigatório. Recomendado: {providerId}:{externalTransactionId}, por exemplo provider-a:transaction-123. A Idempotency-Key é a fonte da verdade. Reenviar a mesma chave com o mesmo corpo devolve o resultado original com idempotentReplay=true. Reenviar a mesma chave com corpo diferente é conflito (409).',
  })
  @ApiBody({ type: SubmitWagerDto })
  @ApiResponse({ status: 200, type: WagerResultDto, description: 'PROCESSED (inclusive replay)' })
  @ApiResponse({ status: 202, type: WagerResultDto, description: 'PENDING_REFERENCE: a referência ainda não chegou' })
  @ApiResponse({ status: 400, description: 'Payload inválido ou Idempotency-Key ausente' })
  @ApiResponse({ status: 409, description: 'Conflito de idempotência: mesma chave com payload diferente' })
  @ApiResponse({ status: 422, type: WagerResultDto, description: 'REJECTED por regra de negócio, com failureCode' })
  @ApiResponse({ status: 500, type: WagerResultDto, description: 'FAILED: falha permanente já registrada. Não reenviar sem investigar.' })
  @ApiResponse({ status: 503, description: 'Falha transitória de infraestrutura. Pode reenviar.' })
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const input = requireBody(body);
    const result = await this.submitWager.execute({
      idempotencyKey: key,
      providerId: requireText(input.providerId, 'providerId'),
      externalTransactionId: requireText(input.externalTransactionId, 'externalTransactionId'),
      playerId: requireUuid(input.playerId, 'playerId'),
      walletId: requireUuid(input.walletId, 'walletId'),
      roundId: requireText(input.roundId, 'roundId'),
      gameId: requireText(input.gameId, 'gameId'),
      kind: requireText(input.kind, 'kind'),
      money: requireMoney(input.money, 'money'),
      referenceExternalTransactionId:
        input.referenceExternalTransactionId === undefined || input.referenceExternalTransactionId === null
          ? null
          : requireText(input.referenceExternalTransactionId, 'referenceExternalTransactionId'),
    });

    if (result.status === 'REJECTED') {
      res.status(422);
    } else if (result.status === 'PENDING_REFERENCE') {
      res.status(202);
    } else if (result.status === 'FAILED') {
      // Falha permanente já registrada. O provedor não deve reenviar sem investigar.
      res.status(500);
    }
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({ summary: 'Consulta uma transação pelo id interno' })
  @ApiParam({ name: 'transactionId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Transação com status, saldo e failureCode quando houver' })
  @ApiResponse({ status: 404, description: 'Transação não encontrada' })
  async getById(@Param('transactionId') transactionId: string) {
    return this.readModel.getTransaction(requireUuid(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({ summary: 'Consulta uma transação pelo id do provedor' })
  @ApiParam({ name: 'providerId', example: 'provider-a' })
  @ApiParam({ name: 'externalTransactionId', example: 'transaction-123' })
  @ApiResponse({ status: 200, description: 'Transação com status, saldo e failureCode quando houver' })
  @ApiResponse({ status: 404, description: 'Transação não encontrada' })
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.readModel.getTransactionByExternalId(
      requireText(providerId, 'providerId'),
      requireText(externalTransactionId, 'externalTransactionId'),
    );
  }
}
