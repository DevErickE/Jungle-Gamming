/**
 * Demonstração ao vivo: executa o fluxo completo contra a API em execução e explica cada passo.
 * Uso: bun run demo (com a aplicação rodando em API_URL, padrão http://localhost:3000).
 */
import { randomUUID } from 'node:crypto';

const BASE = process.env.API_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const PROVIDER = 'provider-a';
const ROUND = `round-${RUN}`;

// Respostas da API são JSON; o demo só lê os campos que mostra.
type Json = Record<string, any>;

function title(text: string): void {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);
}

function explain(text: string): void {
  console.log(`\n# ${text}`);
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: Json | string }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: Json | string = text;
  try {
    data = JSON.parse(text) as Json;
  } catch {
    // resposta não é JSON (ex.: /metrics em texto)
  }
  console.log(`-> ${method} ${path}  [HTTP ${response.status}]`);
  if (typeof data === 'string') {
    console.log(data.split('\n').filter((line) => line.startsWith('wager_') || line.startsWith('wallet_') || line.startsWith('outbox_')).join('\n') || text);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
  return { status: response.status, data };
}

function betBody(externalTransactionId: string, kind: string, amount: string, extra: Json = {}, playerId: string, walletId: string): Json {
  return {
    providerId: PROVIDER,
    externalTransactionId,
    playerId,
    walletId,
    roundId: ROUND,
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

async function main(): Promise<void> {
  title('1. A aplicação está de pé?');
  explain('O /health/ready confirma que o PostgreSQL e o SQS (LocalStack) respondem. Se falhar, a API devolve 503.');
  const ready = await call('GET', '/health/ready');
  if (ready.status !== 200) {
    console.log('\nAPI não está pronta. Suba com: docker compose up -d && bun run db:migrate && bun run start:dev');
    process.exit(1);
  }

  title('2. Criar a carteira do jogador com R$ 100,00');
  explain('O saldo inicial vira uma linha de OPENING no ledger. O valor é guardado em centavos (bigint), nunca em float.');
  const playerId = randomUUID();
  const created = await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const walletId = (created.data as Json).id as string;

  title('3. Aposta de R$ 25,00 (BET)');
  explain('A aposta roda em uma transação: trava a wallet com SELECT ... FOR UPDATE, grava a transação, o lançamento no ledger e atualiza o saldo. Tudo ou nada.');
  const bet = await call(
    'POST',
    '/wagering/transactions',
    betBody(`bet-${RUN}`, 'BET', '25.00', {}, playerId, walletId),
    { 'Idempotency-Key': `${PROVIDER}:bet-${RUN}` },
  );
  const betId = (bet.data as Json).transactionId as string;

  title('4. Mesma aposta enviada de novo (idempotência)');
  explain('A chave de idempotência é a mesma. O sistema não cobra duas vezes: devolve o resultado original com idempotentReplay = true.');
  await call(
    'POST',
    '/wagering/transactions',
    betBody(`bet-${RUN}`, 'BET', '25.00', {}, playerId, walletId),
    { 'Idempotency-Key': `${PROVIDER}:bet-${RUN}` },
  );

  title('5. Aposta maior que o saldo');
  explain('R$ 200,00 com saldo de R$ 75,00: a transação é REJECTED com código WALLET_INSUFFICIENT_FUNDS e HTTP 422. O saldo não muda.');
  await call(
    'POST',
    '/wagering/transactions',
    betBody(`big-${RUN}`, 'BET', '200.00', {}, playerId, walletId),
    { 'Idempotency-Key': `${PROVIDER}:big-${RUN}` },
  );

  title('6. Corrida: 5 apostas de R$ 20,00 ao mesmo tempo com saldo de R$ 75,00');
  explain('As cinco chegam juntas. O lock por wallet faz uma esperar a outra, então exatamente 3 passam (60,00) e 2 são rejeitadas. Nunca fica negativo.');
  const race = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      call(
        'POST',
        '/wagering/transactions',
        betBody(`race-${RUN}-${index}`, 'BET', '20.00', {}, playerId, walletId),
        { 'Idempotency-Key': `${PROVIDER}:race-${RUN}-${index}` },
      ),
    ),
  );
  const processed = race.filter((item) => item.status === 200).length;
  const rejected = race.filter((item) => item.status === 422).length;
  console.log(`\nResumo da corrida: ${processed} PROCESSED, ${rejected} REJECTED`);

  title('7. Ganho de R$ 40,00 (WIN) referenciando a aposta');
  explain('WIN é crédito. O referenceExternalTransactionId liga o ganho à aposta original do mesmo provedor.');
  await call(
    'POST',
    '/wagering/transactions',
    betBody(`win-${RUN}`, 'WIN', '40.00', { referenceExternalTransactionId: `bet-${RUN}` }, playerId, walletId),
    { 'Idempotency-Key': `${PROVIDER}:win-${RUN}` },
  );

  title('8. Consulta da transação por id e por id externo');
  explain('Duas formas de consulta: pelo id interno (UUID) ou pelo id que o provedor conhece.');
  await call('GET', `/wagering/transactions/${betId}`);
  await call('GET', `/providers/${PROVIDER}/wagering/transactions/bet-${RUN}`);

  title('9. Extrato da carteira (ledger)');
  explain('Cada movimento é um lançamento imutável. Um trigger no banco impede UPDATE e DELETE nessa tabela.');
  await call('GET', `/wallets/${walletId}/ledger?limit=20`);

  title('10. Saldo atual');
  await call('GET', `/wallets/${walletId}`);

  title('11. Reconciliação');
  explain('Compara o saldo guardado com a soma do ledger. Se divergir, o sistema sinaliza e registra métrica, mas nunca corrige sozinho.');
  await call('POST', `/wallets/${walletId}/reconciliation`);

  title('12. Métricas');
  explain('Contadores no formato Prometheus. Aqui filtramos só as métricas de negócio.');
  await call('GET', '/metrics');

  title('Fim do demo');
  console.log(`Carteira usada: ${walletId}`);
  console.log('Os dados ficam no banco. Para zerar, rode: docker compose down -v && docker compose up -d && bun run db:migrate');
}

main().catch((error: unknown) => {
  console.error('Falha no demo:', error);
  process.exit(1);
});
