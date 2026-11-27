/**
 * Runtime da compactação (S-17, CMP-6/CMP-7): decide quando compactar antes da
 * chamada, retenta UMA vez quando o provider rejeita por tamanho e respeita a
 * pausa do breaker.
 */
import { setTimeout as delay } from "node:timers/promises";
import { throwIfAborted, isAbortError } from "../abort";
import type { Auditor } from "../audit";
import type { Ledger } from "../ledger";
import { RETRYABLE_CLASSES } from "../providers/policy";
import { ProviderError, type ChatMessage, type CompletionResponse } from "../providers/types";
import {
  applyBackgroundCompaction,
  PREWARM_MARGIN,
  type BackgroundCompaction,
  type BackgroundCompactor,
  type CompactionIdentity,
} from "./background";
import {
  compactionState,
  COMPACTION_FAILURE_LIMIT,
  recordCompactionFailure,
  recordCompactionSuccess,
} from "./breaker";
import {
  RECENT_TOKENS,
  compactSession,
  deterministicSummary,
  effectiveRecentBudget,
  recentSliceStart,
  reserveTokens,
  shouldCompact,
  type CompactionConfig,
} from "./engine";
import { countMessageTokens } from "../tokens";

export interface CompactionRuntimeOptions {
  ledger: Ledger;
  audit: Auditor;
  run: string;
  agent: () => string;
  window: () => number;
  provider: () => string;
  model: () => string;
  compaction: CompactionConfig;
  signal?: AbortSignal;
  /** Completion real sobre as mensagens correntes. */
  complete: (messages: readonly ChatMessage[]) => Promise<CompletionResponse>;
  /** Resumo sem tools. */
  summarize: (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;
  /** Chamado após uma compactação aplicada (ex.: atualizar histórico do agente). */
  onCompacted?: (messages: readonly ChatMessage[]) => void;
  /** Fila de compactação em background (CMP-9); ausente = sempre inline. */
  background?: BackgroundCompactor;
}

/** Vocabulário de tamanho/estouro; "context caching" não é overflow. */
const OVERFLOW_PATTERN = /context\s*(length|window)|maximum.{0,24}(token|context)|prompt is too (large|long)|(input|request|message)s?.{0,16}too (long|large)|too many tokens|token.{0,24}(limit|maximum)|exceeds?.{0,12}context/i;

/** O provider rejeitou por tamanho de contexto? */
export function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.errClass !== "invalid_request") return false;
  return OVERFLOW_PATTERN.test(error.message);
}

type CompactReason = "trigger" | "overflow";

/** Identidade do job de background: invalida resumo de outro modelo/janela. */
function identityOf(opts: CompactionRuntimeOptions): CompactionIdentity {
  return {
    provider: opts.provider(),
    model: opts.model(),
    window: opts.window(),
    buffer: opts.compaction.buffer,
  };
}

/** Overhead estimado do artefato no contexto compactado (tokens). */
const ARTIFACT_OVERHEAD = 2_000;

/** Only transient failures are retried (D-18): a deterministic error repeats forever. */
function isRetryableSummaryError(error: unknown): boolean {
  return error instanceof ProviderError && RETRYABLE_CLASSES.has(error.errClass);
}

/** Audit label of a failure: the D-18 class when known, `unclassified` otherwise. */
function errorSummary(error: unknown): string {
  return error instanceof ProviderError ? error.errClass : "unclassified";
}

/** Wait between attempts; aborting the run stops it immediately. */
function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, signal === undefined ? {} : { signal });
}

/** A compactação consegue projetar o contexto abaixo do gatilho? */
function projectionCanClear(messages: readonly ChatMessage[], opts: CompactionRuntimeOptions): boolean {
  const window = opts.window();
  const tokenOpts = { provider: opts.provider() };
  const systemTokens = messages[0]?.role === "system"
    ? countMessageTokens([messages[0]!], tokenOpts).tokens
    : 0;
  const start = recentSliceStart(
    messages,
    effectiveRecentBudget(window, opts.compaction.buffer, undefined, systemTokens),
  );
  const older = start - (messages[0]?.role === "system" ? 1 : 0);
  if (older <= 0) return false;
  // Já acima da janela: compactar é estritamente benéfico, mesmo que o corte
  // não volte abaixo do gatilho (o provider recusaria a request atual).
  if (countMessageTokens(messages, tokenOpts).tokens > window) return true;
  const recentTokens = countMessageTokens(messages.slice(start), tokenOpts).tokens;
  return systemTokens + recentTokens + ARTIFACT_OVERHEAD < window - reserveTokens(window, opts.compaction.buffer);
}

/**
 * Compacts, records success/failure and opens the breaker when needed.
 * The breaker gates only the model summary: paused or failed, compaction
 * continues through the extractive path (no provider) and never interrupts
 * the run (CMP-6).
 */
async function applyCompaction(
  messages: ChatMessage[],
  opts: CompactionRuntimeOptions,
  reason: CompactReason,
): Promise<boolean> {
  // Without older history or a projection that clears the trigger, repeating
  // on every step would only spend summary tokens without shrinking context.
  if (reason === "trigger" && !projectionCanClear(messages, opts)) return false;
  const state = compactionState(opts.ledger, opts.run);

  const agent = opts.agent();
  const maxRetries = opts.compaction.maxRetries ?? 2;
  const retryBackoffMs = opts.compaction.retryBackoffMs ?? 1000;

  // A paused breaker gates the model summary: compaction goes extractive and
  // the run keeps going (CMP-6).
  if (state.paused) return applyExtractive(messages, opts, reason, "paused");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await compactSession({
        run: opts.run,
        messages,
        window: opts.window(),
        buffer: opts.compaction.buffer,
        provider: opts.compaction.summaryProvider ?? opts.provider(),
        summarize: opts.summarize,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (result.olderCount === 0) {
        // Nothing older to replace (e.g. a first task that is already large).
        return false;
      }
      messages.length = 0;
      messages.push(...result.messages);
      recordCompactionSuccess(opts.ledger, opts.run, agent);
      opts.onCompacted?.(messages);
      opts.audit.append({
        run: opts.run,
        agent,
        tipo: "compaction.applied",
        payload: {
          reason,
          reduction: result.reduction,
          originalTokens: result.originalTokens,
          returnedTokens: result.returnedTokens,
          attempt: attempt + 1,
        },
      });
      return true;
    } catch (error) {
      if (isAbortError(error, opts.signal)) throw error;

      // Only transient failures are retried: a deterministic error repeats the
      // same failure forever.
      if (!isRetryableSummaryError(error) || attempt === maxRetries) {
        const after = recordCompactionFailure(opts.ledger, opts.run, agent);
        opts.audit.append({
          run: opts.run,
          agent,
          tipo: "compaction.failed",
          payload: { reason, error: errorSummary(error), attempts: attempt + 1 },
        });
        if (after.paused) {
          // Later compactions skip the model until the pause expires; none of
          // them stops compacting.
          opts.audit.append({
            run: opts.run,
            agent,
            tipo: "compaction.paused",
            payload: { reason, remainingMs: after.remainingMs },
          });
        }
        // The model failed: compaction continues through the extractive path.
        return applyExtractive(messages, opts, reason, errorSummary(error));
      }

      // Retry with backoff
      opts.audit.append({
        run: opts.run,
        agent,
        tipo: "compaction.retry",
        payload: { reason, error: errorSummary(error), attempt: attempt + 1, nextInMs: retryBackoffMs * 2 ** attempt },
      });
      await backoff(retryBackoffMs * 2 ** attempt, opts.signal);
      throwIfAborted(opts.signal);
    }
  }
  return false; // Should not reach here
}

/** Extractive path (CMP-6): no provider call. `cause` is the degradation reason. */
async function applyExtractive(
  messages: ChatMessage[], opts: CompactionRuntimeOptions, reason: CompactReason, cause: string,
): Promise<boolean> {
  const agent = opts.agent();
  const fallback = await compactSession({
    run: opts.run, messages, window: opts.window(), buffer: opts.compaction.buffer,
    provider: opts.provider(), summarize: async (input) => deterministicSummary(input),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  // The fallback must shrink the context: otherwise the caller surfaces the
  // original error, not the summary failure that led here.
  if (fallback.returnedTokens >= fallback.originalTokens) {
    return false;
  }
  messages.length = 0;
  messages.push(...fallback.messages);
  opts.onCompacted?.(messages);
  opts.audit.append({
    run: opts.run, agent, tipo: "compaction.degraded",
    payload: { reason, cause, reduction: fallback.reduction },
  });
  return true;
}

/**
 * The ready background artifact, unless the breaker still owes a model probe.
 * A paused breaker gates the model summary; after the pause expires the
 * counter is still open, so a pre-pause artifact is neither applied nor
 * allowed to clear it — an inline model probe does that.
 */
function takeReadyArtifact(
  messages: ChatMessage[],
  opts: CompactionRuntimeOptions,
): BackgroundCompaction | undefined {
  const state = compactionState(opts.ledger, opts.run);
  if (state.paused || state.failures >= COMPACTION_FAILURE_LIMIT) return undefined;
  return opts.background?.take(opts.agent(), messages, identityOf(opts));
}

/**
 * Applies a ready artifact (already summarized): no provider call and no rewrite
 * of the ledger/audit schema.
 */
function applyReadyCompaction(
  messages: ChatMessage[],
  job: BackgroundCompaction,
  opts: CompactionRuntimeOptions,
  reason: CompactReason,
): void {
  const agent = opts.agent();
  applyBackgroundCompaction(messages, job);
  recordCompactionSuccess(opts.ledger, opts.run, agent);
  opts.onCompacted?.(messages);
  opts.audit.append({
    run: opts.run,
    agent,
    tipo: "compaction.applied",
    payload: {
      reason,
      background: true,
      reduction: job.reduction,
      originalTokens: job.originalTokens,
      returnedTokens: job.returnedTokens,
    },
  });
}

/**
 * Pré-aquece a compactação depois de um step que ainda vai chamar o provider.
 * O snapshot é do prefixo atual; a cauda nova é preservada na aplicação.
 */
function scheduleCompaction(
  messages: readonly ChatMessage[],
  opts: CompactionRuntimeOptions,
  response: CompletionResponse,
): void {
  const background = opts.background;
  if (background === undefined || response.toolCalls.length === 0) return;
  const window = opts.window();
  const trigger = window - reserveTokens(window, opts.compaction.buffer);
  if (trigger < PREWARM_MARGIN * 2) return; // janela pequena: inline é previsível
  const tokens = countMessageTokens(messages, { provider: opts.provider() }).tokens;
  if (tokens >= trigger || tokens < trigger - PREWARM_MARGIN) return;
  if (compactionState(opts.ledger, opts.run).paused) return;
  // Sem histórico antigo ou sem projeção para sair do gatilho, resumir de novo
  // não reduziria o contexto: deixa o inline decidir.
  if (!projectionCanClear(messages, opts)) return;
  const identity = identityOf(opts);
  const summarize = opts.summarize;
  try {
    background.schedule(opts.agent(), messages, tokens, identity, (snapshot, signal) => compactSession({
      run: opts.run,
      messages: snapshot,
      window,
      buffer: opts.compaction.buffer,
      provider: identity.provider,
      summarize,
      signal,
    }), opts.signal);
  } catch { /* pré-aquecimento nunca quebra o turno */ }
}

/** Compacta antes da chamada quando o gatilho dispara e retenta uma vez por overflow. */
export async function completeWithCompaction(
  messages: ChatMessage[],
  opts: CompactionRuntimeOptions,
): Promise<CompletionResponse> {
  throwIfAborted(opts.signal);

  if (shouldCompact(messages, opts.window(), opts.compaction.buffer, { provider: opts.provider() })) {
    const ready = takeReadyArtifact(messages, opts);
    if (ready !== undefined) applyReadyCompaction(messages, ready, opts, "trigger");
    else await applyCompaction(messages, opts, "trigger");
    throwIfAborted(opts.signal);
  }

  try {
    const response = await opts.complete(messages);
    scheduleCompaction(messages, opts, response);
    return response;
  } catch (error) {
    if (!isContextOverflow(error)) throw error;
    const ready = takeReadyArtifact(messages, opts);
    let compacted = true;
    if (ready !== undefined) applyReadyCompaction(messages, ready, opts, "overflow");
    else compacted = await applyCompaction(messages, opts, "overflow");
    throwIfAborted(opts.signal);
    // Sem nada para compactar, repetir a mesma request só gastaria uma chamada.
    if (!compacted) throw error;
    // Segunda rejeição é terminal (CMP-7): o erro sobe para a sessão.
    return await opts.complete(messages);
  }
}