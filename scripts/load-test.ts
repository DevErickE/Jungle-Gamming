/**
 * Teste de carga: envia apostas concorrentes para a API, mede cada resposta e, no fim, confere
 * que o saldo de cada carteira e a reconciliação batem com o que foi processado.
 *
 *   bun run test:load
 *
 * Variáveis (todas opcionais):
 *   LOAD_API_URL      endereço da API (padrão http://localhost:3000)
 *   LOAD_REQUESTS     total de apostas enviadas (padrão 2000)
 *   LOAD_CONCURRENCY  requisições simultâneas (padrão 50)
 *   LOAD_WALLETS      carteiras usadas; apostas na mesma carteira disputam o lock (padrão 10)
 *   LOAD_DRAIN_MS     tempo máximo para a outbox esvaziar depois da carga (padrão 60000)
 *
 * Código de saída diferente de zero quando há erro 5xx, falha de rede, saldo divergente ou
 * reconciliação inconsistente. Latência alta não reprova: ela é só medida e reportada.
 */

const API = process.env.LOAD_API_URL ?? 'http://localhost:3000';
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 2000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const WALLET_COUNT = Number(process.env.LOAD_WALLETS ?? 10);
// O publicador envia até 50 eventos por segundo. Com 2 eventos por aposta, 2.000 apostas
// geram 4.000 eventos, que levam cerca de 80 s para sair. O prazo cobre esse caso.
const DRAIN_MS = Number(process.env.LOAD_DRAIN_MS ?? 180_000);

const PROVIDER = 'load-provider';
const GAME = 'load-game';
const INITIAL = '1000.00';
const BET = '0.01';
const BET_MINOR = 1;
const INITIAL_MINOR = 100_000;

const runId = Bun.randomUUIDv7().slice(-12);

interface Wallet {
  id: string;
  playerId: string;
}

interface Sample {
  walletIndex: number;
  httpStatus: number;
  resultStatus: string;
  latencyMs: number;
}

async function createWallet(): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${API}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: INITIAL, currency: 'BRL' } }),
  });
  if (response.status !== 201) {
    throw new Error(`falha ao criar carteira: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { id: string };
  return { id: body.id, playerId };
}

async function submitBet(wallet: Wallet, walletIndex: number, index: number): Promise<Sample> {
  const externalTransactionId = `load-${runId}-${index}`;
  const started = performance.now();
  try {
    const response = await fetch(`${API}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': `${PROVIDER}:${externalTransactionId}`,
      },
      body: JSON.stringify({
        providerId: PROVIDER,
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-${index % 50}`,
        gameId: GAME,
        kind: 'BET',
        money: { amount: BET, currency: 'BRL' },
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { status?: string };
    return {
      walletIndex,
      httpStatus: response.status,
      resultStatus: body.status ?? 'SEM_CORPO',
      latencyMs: performance.now() - started,
    };
  } catch {
    return { walletIndex, httpStatus: 0, resultStatus: 'ERRO_DE_REDE', latencyMs: performance.now() - started };
  }
}

/** Dispara as apostas com `CONCURRENCY` workers, cada um esperando a resposta anterior. */
async function runLoad(wallets: Wallet[]): Promise<{ samples: Sample[]; seconds: number }> {
  const samples: Sample[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < REQUESTS) {
      const index = next;
      next += 1;
      const walletIndex = index % wallets.length;
      const wallet = wallets[walletIndex];
      if (wallet) {
        samples.push(await submitBet(wallet, walletIndex, index));
      }
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { samples, seconds: (performance.now() - started) / 1000 };
}

async function readMetric(name: string): Promise<number> {
  const text = await (await fetch(`${API}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(' ')[1]) : Number.NaN;
}

/** Amostra o lag da outbox a cada segundo durante a carga, para registrar o pico. */
function startLagSampler(): { stop: () => number } {
  let maxLag = 0;
  const timer = setInterval(() => {
    readMetric('outbox_lag_seconds')
      .then((lag) => {
        if (Number.isFinite(lag)) {
          maxLag = Math.max(maxLag, lag);
        }
      })
      .catch(() => undefined);
  }, 1000);
  return {
    stop: () => {
      clearInterval(timer);
      return maxLag;
    },
  };
}

/** Espera a outbox esvaziar. Retorna o tempo até o lag zerar, ou null se estourar. */
async function waitForDrain(): Promise<number | null> {
  const started = performance.now();
  while (performance.now() - started < DRAIN_MS) {
    const lag = await readMetric('outbox_lag_seconds');
    if (lag === 0) {
      return (performance.now() - started) / 1000;
    }
    await Bun.sleep(500);
  }
  return null;
}

async function walletBalanceMinor(wallet: Wallet): Promise<bigint> {
  const body = (await (await fetch(`${API}/wallets/${wallet.id}`)).json()) as { balance: { amount: string } };
  const [whole = '0', cents = '0'] = body.balance.amount.split('.');
  return BigInt(whole) * 100n + BigInt(cents);
}

async function reconcile(wallet: Wallet): Promise<boolean> {
  const response = await fetch(`${API}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
  const body = (await response.json()) as { consistent?: boolean };
  return response.status === 200 && body.consistent === true;
}

/** Percentil pelo método do posto mais próximo. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? Number.NaN;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main(): Promise<void> {
  console.log(`Teste de carga: ${REQUESTS} apostas, ${CONCURRENCY} simultâneas, ${WALLET_COUNT} carteiras, API ${API}`);

  const wallets: Wallet[] = [];
  for (let i = 0; i < WALLET_COUNT; i += 1) {
    wallets.push(await createWallet());
  }

  const sampler = startLagSampler();
  const { samples, seconds } = await runLoad(wallets);
  const maxLagDuringLoad = sampler.stop();
  const drainSeconds = await waitForDrain();

  // Contagem por carteira: o saldo esperado é o inicial menos as apostas aceitas.
  const processedPerWallet = wallets.map(() => 0);
  for (const sample of samples) {
    if (sample.resultStatus === 'PROCESSED') {
      processedPerWallet[sample.walletIndex] = (processedPerWallet[sample.walletIndex] ?? 0) + 1;
    }
  }

  let balanceMismatches = 0;
  let reconciliationFailures = 0;
  for (const [index, wallet] of wallets.entries()) {
    const expected = BigInt(INITIAL_MINOR) - BigInt(processedPerWallet[index] ?? 0) * BigInt(BET_MINOR);
    if ((await walletBalanceMinor(wallet)) !== expected) {
      balanceMismatches += 1;
    }
    if (!(await reconcile(wallet))) {
      reconciliationFailures += 1;
    }
  }

  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const statusCounts: Record<string, number> = {};
  for (const sample of samples) {
    const key = `${sample.httpStatus} ${sample.resultStatus}`;
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  const serverErrors = samples.filter((s) => s.httpStatus >= 500 || s.httpStatus === 0).length;

  const report = {
    ambiente: {
      runtime: `Bun ${Bun.version}`,
      plataforma: `${process.platform} ${process.arch}`,
      cpus: navigator.hardwareConcurrency,
      api: API,
      data: new Date().toISOString(),
    },
    metodologia: {
      apostas: REQUESTS,
      concorrencia: CONCURRENCY,
      carteiras: WALLET_COUNT,
      valorDaAposta: BET,
      tiposDeOperacao: 'BET apenas, com rodada e jogo fixos por carteira',
    },
    throughput: {
      segundos: round(seconds),
      requisicoesPorSegundo: round(samples.length / seconds),
    },
    latenciaMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies[latencies.length - 1] ?? Number.NaN),
    },
    resultados: statusCounts,
    erros: {
      erroDeServidorOuRede: serverErrors,
      taxa: round((serverErrors / samples.length) * 100) / 100,
    },
    outbox: {
      lagMaximoDuranteACarga: round(maxLagDuringLoad),
      segundosParaEsvaziar: drainSeconds === null ? 'não esvaziou no prazo' : round(drainSeconds),
    },
    consistencia: {
      carteirasComSaldoDivergente: balanceMismatches,
      carteirasComReconciliacaoInconsistente: reconciliationFailures,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  const failed = serverErrors > 0 || balanceMismatches > 0 || reconciliationFailures > 0 || drainSeconds === null;
  if (failed) {
    console.error('Teste de carga reprovado: veja os campos erros, outbox e consistencia.');
    process.exit(1);
  }
}

await main();
