/**
 * Sinal efetivo de uma chamada de rede (I-09): o abort do caller continua
 * cancelando, mas um timeout próprio impede que um servidor pendurado segure a
 * chamada para sempre. O timeout é classificado como `network_timeout`, não
 * como cota dura.
 */

/** Timeout de rede padrão por chamada de provider. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export interface NetworkCall {
  signal: AbortSignal;
  /** O timer de inatividade próprio disparou (distinto de o caller ter cancelado). */
  timedOut(): boolean;
  /** O teto total próprio disparou; só existe quando há teto (#519). */
  totalTimedOut(): boolean;
  /**
   * Se `error` é exatamente o erro que um timer próprio disparou, diz qual
   * ("idle" ou "total"). Permite classificar o timeout próprio como
   * `network_timeout` mesmo quando o caller também abortou na mesma janela (#519).
   */
  ownTimeout(error: unknown): "idle" | "total" | undefined;
  /**
   * Reinicia o prazo de inatividade (#475): no stream cada chunk recebido conta
   * como atividade. Depois de estourar, de o caller cancelar ou de `dispose()`,
   * não faz nada. O teto total nunca é reiniciado (#519).
   */
  reset(): void;
  /** Cancela os timers e remove o listener do caller. */
  dispose(): void;
}

export function networkCall(caller: AbortSignal | undefined, timeoutMs: number, totalMs?: number): NetworkCall {
  const controller = new AbortController();
  let timedOut = false;
  let totalTimedOutFlag = false;
  let disposed = false;
  let idleReason: unknown;
  let totalReason: unknown;

  const onCallerAbort = (): void => controller.abort(caller?.reason);
  if (caller?.aborted === true) controller.abort(caller.reason);
  else caller?.addEventListener("abort", onCallerAbort, { once: true });

  const arm = (): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      timedOut = true;
      idleReason = new DOMException(`timeout de inatividade após ${timeoutMs}ms`, "TimeoutError");
      controller.abort(idleReason);
    }, timeoutMs);

  let timer = arm();

  // Teto total (#519): dispara uma vez, não é reiniciado por atividade.
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  if (totalMs !== undefined) {
    totalTimer = setTimeout(() => {
      totalTimedOutFlag = true;
      totalReason = new DOMException(`timeout total após ${totalMs}ms`, "TimeoutError");
      controller.abort(totalReason);
    }, totalMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    totalTimedOut: () => totalTimedOutFlag,
    ownTimeout: (error) => (error === idleReason ? "idle" : error === totalReason ? "total" : undefined),
    reset: () => {
      if (disposed || timedOut || totalTimedOutFlag || controller.signal.aborted) return;
      clearTimeout(timer);
      timer = arm();
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}
