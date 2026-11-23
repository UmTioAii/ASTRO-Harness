/**
 * Fan-out de subagentes (A11, ADR-0008): executa jobs independentes com um
 * teto de concorrência e serializa jobs da mesma conta (A4). Cada job recebe
 * um sinal próprio: abortar ou falhar um filho não toca nos irmãos.
 */
import { redactSecrets } from "./sanitize-external";
import { DEFAULT_MAX_CONCURRENT_PER_PROVIDER } from "./concurrency";

export interface FanOutJob<T> {
  id: string;
  /** Conta exclusiva do job; jobs da mesma conta nunca rodam juntos. */
  account: string;
  run: (signal: AbortSignal) => Promise<T>;
}

export type FanOutOutcome<T> =
  | { id: string; ok: true; value: T }
  | { id: string; ok: false; error: string };

export interface FanOutOptions {
  /** `false` = serial (default do v1); `true` = paralelo com limite. */
  parallel: boolean;
  /** Teto de jobs simultâneos; inteiro positivo. */
  maxActive: number;
  /** Execuções simultâneas por conta (ADR-0037); default 2. */
  maxPerAccount?: number;
  signal?: AbortSignal;
  /** Só no caminho serial: interrompe a fila (ex.: pausa de permissão). */
  stopOnError?: (error: unknown) => boolean;
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Valida o teto antes de qualquer job começar. */
export function assertFanOutBound(maxActive: number): void {
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    throw new RangeError(`fan-out: maxActive deve ser inteiro positivo (recebido ${String(maxActive)})`);
  }
}

/** Executa jobs em ordem de entrada; resultados também saem na ordem de entrada. */
export async function runFanOut<T>(
  jobs: readonly FanOutJob<T>[],
  opts: FanOutOptions,
): Promise<FanOutOutcome<T>[]> {
  assertFanOutBound(opts.maxActive);
  const results: FanOutOutcome<T>[] = new Array(jobs.length);
  if (jobs.length === 0) return results;

  const controllers = jobs.map(() => new AbortController());
  const abortAll = (): void => {
    for (const controller of controllers) controller.abort();
  };
  opts.signal?.addEventListener("abort", abortAll, { once: true });

  const runOne = async (job: FanOutJob<T>, index: number, stopOnError?: (error: unknown) => boolean): Promise<void> => {
    if (opts.signal?.aborted === true) {
      results[index] = { id: job.id, ok: false, error: "aborted" };
      return;
    }
    try {
      results[index] = { id: job.id, ok: true, value: await job.run(controllers[index]!.signal) };
    } catch (error) {
      results[index] = { id: job.id, ok: false, error: errorMessage(error) };
      if (stopOnError?.(error) === true) throw error;
    }
  };

  try {
    if (!opts.parallel) {
      for (const [index, job] of jobs.entries()) await runOne(job, index, opts.stopOnError);
      return results;
    }

    // ADR-0037: a conta é compartilhada até `maxPerAccount`; contas distintas
    // disputam os `maxActive` slots globais. A ordem de entrada é preservada.
    const perAccount = opts.maxPerAccount ?? DEFAULT_MAX_CONCURRENT_PER_PROVIDER;
    assertFanOutBound(perAccount);
    const byAccount = new Map<string, number>();
    let active = 0;
    // Acorda todos: um waiter pode estar bloqueado pela conta enquanto outro tem slot.
    const waiters: Array<() => void> = [];
    const wakeAll = (): void => {
      for (const resolve of waiters.splice(0)) resolve();
    };
    const acquire = async (account: string): Promise<void> => {
      while (active >= opts.maxActive || (byAccount.get(account) ?? 0) >= perAccount) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      active++;
      byAccount.set(account, (byAccount.get(account) ?? 0) + 1);
    };
    const release = (account: string): void => {
      active--;
      byAccount.set(account, (byAccount.get(account) ?? 1) - 1);
      wakeAll();
    };

    await Promise.all(jobs.map(async (job, index) => {
      await acquire(job.account);
      try {
        await runOne(job, index);
      } finally {
        release(job.account);
      }
    }));
  } finally {
    opts.signal?.removeEventListener("abort", abortAll);
  }
  return results;
}
