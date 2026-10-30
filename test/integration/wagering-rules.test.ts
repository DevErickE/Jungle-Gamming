import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DataSource } from 'typeorm';
import pg from 'pg';
import { SubmitWagerUseCase, type SubmitWagerInput } from '../../src/application/wagering/submit-wager.use-case.ts';
import { FailureCode } from '../../src/domain/wagering/failure-code.ts';
import { createOrm } from '../../src/infrastructure/persistence/orm.ts';
import {
  TEST_DATABASE_URL,
  assertLedgerMatchesBalance,
  openWallet,
  resetTestDatabase,
} from '../helpers/database.ts';

let orm: DataSource;
let useCase: SubmitWagerUseCase;
let client: pg.Client;

beforeAll(async () => {
  await resetTestDatabase();
  orm = await createOrm(TEST_DATABASE_URL);
  useCase = new SubmitWagerUseCase(orm);
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await orm?.destroy();
});

type Wallet = { id: string; playerId: string };

/** Monta uma transação para uma wallet. Valores em reais (string decimal). */
function op(
  wallet: Wallet,
  kind: string,
  externalTransactionId: string,
  amount: string,
  overrides: Partial<SubmitWagerInput> = {},
): SubmitWagerInput {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId: null,
    ...overrides,
  };
}

const ref = (wallet: Wallet, kind: string, externalTransactionId: string, amount: string, referenceId: string) =>
  op(wallet, kind, externalTransactionId, amount, { referenceExternalTransactionId: referenceId });

async function balanceOf(walletId: string): Promise<string> {
  const result = await client.query<{ balance_minor: string }>(
    'SELECT balance_minor FROM wallets WHERE id = $1',
    [walletId],
  );
  return result.rows[0]?.balance_minor ?? 'missing';
}

/** Saldo em reais, no formato de exibição (ex.: "75.00"). */
async function balanceAmount(walletId: string): Promise<string> {
  const minor = BigInt(await balanceOf(walletId));
  return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
}

async function statusOf(externalTransactionId: string): Promise<{ status: string; failure_code: string | null }> {
  const result = await client.query<{ status: string; failure_code: string | null }>(
    'SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = $1',
    [externalTransactionId],
  );
  return result.rows[0] ?? { status: 'missing', failure_code: null };
}

async function ledgerCountFor(transactionId: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE transaction_id = $1',
    [transactionId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Id interno da transação de referência gravada em `reference_transaction_id`. */
async function referenceOf(externalTransactionId: string): Promise<string | null> {
  const result = await client.query<{ reference_transaction_id: string | null }>(
    'SELECT reference_transaction_id FROM wager_transactions WHERE external_transaction_id = $1',
    [externalTransactionId],
  );
  return result.rows[0]?.reference_transaction_id ?? null;
}

async function outboxEventsFor(transactionId: string): Promise<string[]> {
  const result = await client.query<{ event_type: string }>(
    "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 ORDER BY event_type",
    [transactionId],
  );
  return result.rows.map((row) => row.event_type);
}

describe('WIN', () => {
  test('WIN com referência à BET credita o valor e fica consistente com o ledger', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'w-bet-1', '30.00'));

    const win = await useCase.execute(ref(wallet, 'WIN', 'w-win-1', '50.00', 'w-bet-1'));

    expect(win.status).toBe('PROCESSED');
    expect(win.balance).toEqual({ amount: '120.00', currency: 'BRL' });
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('WIN referenciando LOSS é REFERENCE_INVALID_KIND: WIN só aponta para BET', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'w-on-loss-bet', '10.00'));
    await useCase.execute(ref(wallet, 'LOSS', 'w-on-loss-loss', '10.00', 'w-on-loss-bet'));

    const win = await useCase.execute(ref(wallet, 'WIN', 'w-on-loss-win', '20.00', 'w-on-loss-loss'));

    expect(win.status).toBe('REJECTED');
    expect(win.failureCode).toBe(FailureCode.ReferenceInvalidKind);
    expect(await balanceAmount(wallet.id)).toBe('90.00');
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('WIN sem referência credita diretamente', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const win = await useCase.execute(op(wallet, 'WIN', 'w-free-1', '10.00'));

    expect(win.status).toBe('PROCESSED');
    expect(win.balance).toEqual({ amount: '110.00', currency: 'BRL' });
  });

  test('WIN referenciando BET de outra rodada é REFERENCE_MISMATCH e não altera saldo', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'w-round-bet', '30.00'));

    const win = await useCase.execute(
      ref(wallet, 'WIN', 'w-round-win', '50.00', 'w-round-bet'),
    );
    expect(win.status).toBe('PROCESSED');

    const other = await useCase.execute(
      op(wallet, 'WIN', 'w-other-round', '50.00', { roundId: 'round-2', referenceExternalTransactionId: 'w-round-bet' }),
    );
    expect(other.status).toBe('REJECTED');
    expect(other.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(await balanceOf(wallet.id)).toBe('12000');
  });
});

describe('LOSS', () => {
  test('LOSS é processada sem mover saldo e sem gerar lançamento', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'l-bet-1', '30.00'));

    const loss = await useCase.execute(op(wallet, 'LOSS', 'l-loss-1', '20.00'));

    expect(loss.status).toBe('PROCESSED');
    expect(loss.balance).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(await ledgerCountFor(loss.transactionId)).toBe(0);
    expect(await outboxEventsFor(loss.transactionId)).toEqual(['WagerTransactionProcessed']);
  });

  test('LOSS referencia a BET que ela fecha, mesmo quando outra BET da rodada ganhou', async () => {
    const wallet = await openWallet(client, { initialMinor: 20000 });
    const betA = await useCase.execute(op(wallet, 'BET', 'l-ref-bet-a', '100.00'));
    const betB = await useCase.execute(op(wallet, 'BET', 'l-ref-bet-b', '100.00'));
    await useCase.execute(ref(wallet, 'WIN', 'l-ref-win-a', '200.00', 'l-ref-bet-a'));

    const loss = await useCase.execute(ref(wallet, 'LOSS', 'l-ref-loss-b', '100.00', 'l-ref-bet-b'));

    expect(betA.status).toBe('PROCESSED');
    expect(betB.status).toBe('PROCESSED');
    expect(loss.status).toBe('PROCESSED');
    expect(await referenceOf('l-ref-loss-b')).toBe(betB.transactionId);
    expect(await ledgerCountFor(loss.transactionId)).toBe(0);
    expect(await balanceAmount(wallet.id)).toBe('200.00');
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('LOSS referenciando um WIN é REFERENCE_INVALID_KIND', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'WIN', 'l-kind-win', '10.00'));

    const loss = await useCase.execute(ref(wallet, 'LOSS', 'l-kind-loss', '10.00', 'l-kind-win'));

    expect(loss.status).toBe('REJECTED');
    expect(loss.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('LOSS de uma BET que já teve WIN é REFERENCE_ALREADY_SETTLED e não move saldo', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'l-settled-bet', '10.00'));
    await useCase.execute(ref(wallet, 'WIN', 'l-settled-win', '20.00', 'l-settled-bet'));

    const loss = await useCase.execute(ref(wallet, 'LOSS', 'l-settled-loss', '10.00', 'l-settled-bet'));

    expect(loss.status).toBe('REJECTED');
    expect(loss.failureCode).toBe(FailureCode.ReferenceAlreadySettled);
    expect(await balanceAmount(wallet.id)).toBe('110.00');
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('segundo WIN para a mesma BET é REFERENCE_ALREADY_SETTLED e não credita de novo', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'w-double-bet', '100.00'));
    await useCase.execute(ref(wallet, 'WIN', 'w-double-win-1', '100.00', 'w-double-bet'));

    const second = await useCase.execute(ref(wallet, 'WIN', 'w-double-win-2', '200.00', 'w-double-bet'));

    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadySettled);
    expect(await balanceAmount(wallet.id)).toBe('100.00');
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('WIN de uma BET que já teve LOSS é REFERENCE_ALREADY_SETTLED e não credita', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'w-settled-bet', '10.00'));
    await useCase.execute(ref(wallet, 'LOSS', 'w-settled-loss', '10.00', 'w-settled-bet'));

    const win = await useCase.execute(ref(wallet, 'WIN', 'w-settled-win', '20.00', 'w-settled-bet'));

    expect(win.status).toBe('REJECTED');
    expect(win.failureCode).toBe(FailureCode.ReferenceAlreadySettled);
    expect(await balanceAmount(wallet.id)).toBe('90.00');
    await assertLedgerMatchesBalance(client, wallet.id);
  });
});

describe('REFUND', () => {
  test('REFUND devolve o valor da BET e não pode ser repetido', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'r-bet-1', '40.00'));

    const refund = await useCase.execute(ref(wallet, 'REFUND', 'r-refund-1', '40.00', 'r-bet-1'));
    expect(refund.status).toBe('PROCESSED');
    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const second = await useCase.execute(ref(wallet, 'REFUND', 'r-refund-2', '40.00', 'r-bet-1'));
    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await balanceOf(wallet.id)).toBe('10000');
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('REFUND com valor diferente da BET é REFERENCE_AMOUNT_MISMATCH', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'r-amount-bet', '40.00'));

    const refund = await useCase.execute(ref(wallet, 'REFUND', 'r-amount-refund', '10.00', 'r-amount-bet'));
    expect(refund.status).toBe('REJECTED');
    expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });

  test('REFUND de uma WIN é REFERENCE_INVALID_KIND (REFUND só aceita BET)', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'WIN', 'r-kind-win', '10.00'));

    const refund = await useCase.execute(ref(wallet, 'REFUND', 'r-kind-refund', '10.00', 'r-kind-win'));
    expect(refund.status).toBe('REJECTED');
    expect(refund.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('REFUND de BET rejeitada é REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await openWallet(client, { initialMinor: 1000 });
    const bet = await useCase.execute(op(wallet, 'BET', 'r-np-bet', '50.00'));
    expect(bet.status).toBe('REJECTED');

    const refund = await useCase.execute(ref(wallet, 'REFUND', 'r-np-refund', '50.00', 'r-np-bet'));
    expect(refund.status).toBe('REJECTED');
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('ROLLBACK', () => {
  test('ROLLBACK de BET credita o valor de volta', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'rb-bet-1', '40.00'));

    const rollback = await useCase.execute(ref(wallet, 'ROLLBACK', 'rb-1', '40.00', 'rb-bet-1'));
    expect(rollback.status).toBe('PROCESSED');
    expect(rollback.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('ROLLBACK depois de REFUND da mesma BET é rejeitado: a BET é revertida uma única vez', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'rb-both-bet', '40.00'));
    await useCase.execute(ref(wallet, 'REFUND', 'rb-both-refund', '40.00', 'rb-both-bet'));

    const rollback = await useCase.execute(ref(wallet, 'ROLLBACK', 'rb-both-rollback', '40.00', 'rb-both-bet'));
    expect(rollback.status).toBe('REJECTED');
    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await balanceOf(wallet.id)).toBe('10000');
  });

  test('ROLLBACK de WIN debita o valor ganho', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'rb-w-bet', '50.00'));
    await useCase.execute(ref(wallet, 'WIN', 'rb-w-win', '80.00', 'rb-w-bet'));
    expect(await balanceAmount(wallet.id)).toBe('130.00');

    const rollback = await useCase.execute(ref(wallet, 'ROLLBACK', 'rb-w-rollback', '80.00', 'rb-w-win'));
    expect(rollback.status).toBe('PROCESSED');
    expect(rollback.balance).toEqual({ amount: '50.00', currency: 'BRL' });
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('ROLLBACK de WIN que deixaria o saldo negativo é REVERSAL_WOULD_BE_NEGATIVE, sem lançamento', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'neg-bet-1', '100.00'));
    await useCase.execute(ref(wallet, 'WIN', 'neg-win', '50.00', 'neg-bet-1'));
    await useCase.execute(op(wallet, 'BET', 'neg-bet-2', '50.00'));
    expect(await balanceAmount(wallet.id)).toBe('0.00');

    const rollback = await useCase.execute(ref(wallet, 'ROLLBACK', 'neg-rollback', '50.00', 'neg-win'));
    expect(rollback.status).toBe('REJECTED');
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldBeNegative);
    expect(rollback.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(await ledgerCountFor(rollback.transactionId)).toBe(0);
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('ROLLBACK de LOSS é REFERENCE_INVALID_KIND (LOSS não move saldo)', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'LOSS', 'rb-loss', '5.00'));

    const rollback = await useCase.execute(ref(wallet, 'ROLLBACK', 'rb-loss-rollback', '5.00', 'rb-loss'));
    expect(rollback.status).toBe('REJECTED');
    expect(rollback.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('ROLLBACK de REFUND debita o valor reembolsado', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'rb-rf-bet', '40.00'));
    await useCase.execute(ref(wallet, 'REFUND', 'rb-rf-refund', '40.00', 'rb-rf-bet'));

    const rollback = await useCase.execute(ref(wallet, 'ROLLBACK', 'rb-rf-rollback', '40.00', 'rb-rf-refund'));
    expect(rollback.status).toBe('PROCESSED');
    expect(rollback.balance).toEqual({ amount: '60.00', currency: 'BRL' });
  });
});

describe('referência fora de ordem (PENDING_REFERENCE)', () => {
  test('ROLLBACK que chega antes da BET fica pendente e o worker processa depois', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });

    const early = await useCase.execute(ref(wallet, 'ROLLBACK', 'late-rb', '30.00', 'late-bet'));
    expect(early.status).toBe('PENDING_REFERENCE');
    expect(early.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await outboxEventsFor(early.transactionId)).toContain('WagerTransactionPendingReference');

    await useCase.execute(op(wallet, 'BET', 'late-bet', '30.00'));
    expect(await balanceAmount(wallet.id)).toBe('70.00');

    // O worker só reavalia quando o horário de próxima checagem chega.
    expect(await useCase.reprocessPending(new Date(), 50)).toBe(0);
    await useCase.reprocessPending(new Date(Date.now() + 10_000), 50);

    expect((await statusOf('late-rb')).status).toBe('PROCESSED');
    expect(await balanceAmount(wallet.id)).toBe('100.00');
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('referência que nunca chega vira REFERENCE_NOT_FOUND após o limite de tentativas', async () => {
    const limited = new SubmitWagerUseCase(orm, { maxAttempts: 2, backoffBaseMs: 1000 });
    const wallet = await openWallet(client, { initialMinor: 10000 });

    const pending = await limited.execute(ref(wallet, 'REFUND', 'ghost-refund', '10.00', 'ghost-bet'));
    expect(pending.status).toBe('PENDING_REFERENCE');

    await limited.reprocessPending(new Date(Date.now() + 10_000), 50);
    expect((await statusOf('ghost-refund')).status).toBe('PENDING_REFERENCE');

    await limited.reprocessPending(new Date(Date.now() + 3_600_000), 50);
    const final = await statusOf('ghost-refund');
    expect(final.status).toBe('REJECTED');
    expect(final.failure_code).toBe(FailureCode.ReferenceNotFound);
    expect(await outboxEventsFor(pending.transactionId)).toContain('WagerTransactionRejected');
  });

  test('repetir uma transação pendente devolve PENDING_REFERENCE como replay', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    const input = ref(wallet, 'REFUND', 'replay-pending', '10.00', 'replay-bet');

    const first = await useCase.execute(input);
    const replay = await useCase.execute(input);

    expect(first.status).toBe('PENDING_REFERENCE');
    expect(replay.status).toBe('PENDING_REFERENCE');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
  });
});

describe('concorrência nas reversões', () => {
  test('REFUND e ROLLBACK concorrentes da mesma BET: exatamente uma processada', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'race-bet', '40.00'));

    const results = await Promise.all([
      useCase.execute(ref(wallet, 'REFUND', 'race-refund', '40.00', 'race-bet')),
      useCase.execute(ref(wallet, 'ROLLBACK', 'race-rollback', '40.00', 'race-bet')),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await balanceAmount(wallet.id)).toBe('100.00');
    await assertLedgerMatchesBalance(client, wallet.id);
  });

  test('20 reembolsos concorrentes da mesma BET creditam uma única vez', async () => {
    const wallet = await openWallet(client, { initialMinor: 10000 });
    await useCase.execute(op(wallet, 'BET', 'many-bet', '40.00'));

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => useCase.execute(ref(wallet, 'REFUND', `many-refund-${i}`, '40.00', 'many-bet'))),
    );

    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(await balanceAmount(wallet.id)).toBe('100.00');
    await assertLedgerMatchesBalance(client, wallet.id);
  });
});
