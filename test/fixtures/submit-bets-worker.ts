/**
 * Processo filho usado pelo teste multi-processo. Envia N apostas em paralelo
 * para a mesma wallet e imprime o resultado em JSON na saída padrão.
 *
 *   bun test/fixtures/submit-bets-worker.ts <walletId> <playerId> <workerId> <count> <amountMinor>
 */
import { createOrm } from '../../src/infrastructure/persistence/orm.ts';
import { SubmitWagerUseCase } from '../../src/application/wagering/submit-wager.use-case.ts';
import { TEST_DATABASE_URL } from '../helpers/database.ts';

const [walletId, playerId, workerId, count, amountMinor] = process.argv.slice(2);
if (!walletId || !playerId || !workerId || !count || !amountMinor) {
  console.error('uso: submit-bets-worker.ts <walletId> <playerId> <workerId> <count> <amountMinor>');
  process.exit(1);
}

const orm = await createOrm(process.env.DATABASE_URL ?? TEST_DATABASE_URL);
try {
  const useCase = new SubmitWagerUseCase(orm);
  const amount = formatMinor(Number(amountMinor));
  const results = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      useCase.execute({
        idempotencyKey: `worker-${workerId}:bet-${i}`,
        providerId: 'provider-a',
        externalTransactionId: `worker-${workerId}-bet-${i}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      }),
    ),
  );
  console.log(JSON.stringify(results.map((r) => r.status)));
} finally {
  await orm.destroy();
}

function formatMinor(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}
