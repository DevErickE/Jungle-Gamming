import type { SubmitWagerUseCase } from './submit-wager.use-case.ts';

/**
 * Reprocessa periodicamente as transações PENDING_REFERENCE vencidas. O atraso entre
 * tentativas é controlado pelo próprio banco (next_reference_check_at, com backoff),
 * então vários workers podem rodar em paralelo: cada transação é reavaliada sob o lock
 * da sua wallet e só é processada uma vez.
 */
export class PendingReferenceWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly useCase: SubmitWagerUseCase,
    private readonly intervalMs = 1000,
    private readonly batchSize = 50,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  /** Uma passada do worker. Se a anterior ainda estiver rodando, não sobrepõe. */
  tick(now: Date = new Date()): Promise<void> {
    if (this.running) {
      return this.running;
    }
    this.running = this.useCase
      .reprocessPending(now, this.batchSize)
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(JSON.stringify({ level: 'error', message: 'pending reference worker failed', error: String(error) }));
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
