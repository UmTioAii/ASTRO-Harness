/**
 * Fila de compactação em background (CMP-9): no máximo um job em voo, resultado
 * persistido de forma atômica (tmp+rename) com marcador de prontidão. Sem
 * marcador válido o runtime cai no inline — nunca lê artefato parcial.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAbortError } from "../abort";
import type { Auditor } from "../audit";
import type { Ledger } from "../ledger";
import type { ChatMessage } from "../providers/types";
import { recordCompactionFailure } from "./breaker";
import type { CompactResult } from "./engine";
import { renderCompactionArtifact, type CompactionArtifactV1 } from "./types";

export type BackgroundCompactionResult =
  Pick<CompactResult, "artifact" | "reduction" | "originalTokens" | "returnedTokens" | "olderCount" | "recentStart">;

export interface BackgroundCompaction extends BackgroundCompactionResult {
  snapshotKey: string;
  snapshotCount: number;
}

export interface BackgroundCompactorOptions {
  /** Diretório dos artefatos; um par run/agent por arquivo. */
  dir: string;
  run: string;
  ledger: Ledger;
  audit: Auditor;
}

interface Persisted extends BackgroundCompaction {
  schemaVersion: 1;
  run: string;
  agent: string;
}

interface Marker {
  schemaVersion: 1;
  digest: string;
  snapshotKey: string;
  snapshotCount: number;
}

/** Hash determinístico do prefixo do histórico; o conteúdo não é persistido. */
export function snapshotKey(messages: readonly ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "default";
}

export function compactionArtifactPaths(
  dir: string,
  run: string,
  agent: string,
): { artifact: string; marker: string } {
  // Sufixo do par cru evita colisão entre nomes que sanitizam igual.
  const unique = createHash("sha256").update(`${run}\u0000${agent}`).digest("hex").slice(0, 8);
  const base = join(dir, `${safeName(run)}.${safeName(agent)}.${unique}`);
  return { artifact: `${base}.compaction.json`, marker: `${base}.ready` };
}

/** Escrita atômica do harness: tmp exclusivo + rename. */
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp não existe */ }
    throw error;
  }
}

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map((call) => ({ ...call })) }),
  }));
}

function matches(job: BackgroundCompaction, messages: readonly ChatMessage[]): boolean {
  return job.snapshotCount <= messages.length
    && snapshotKey(messages.slice(0, job.snapshotCount)) === job.snapshotKey;
}

/** Aplica o artefato pronto; a cauda acrescentada depois do snapshot é preservada. */
export function applyBackgroundCompaction(messages: ChatMessage[], job: BackgroundCompaction): void {
  const next: ChatMessage[] = [
    ...(messages[0]?.role === "system" ? [messages[0]!] : []),
    { role: "system", content: renderCompactionArtifact(job.artifact) },
    ...messages.slice(job.recentStart),
  ];
  messages.length = 0;
  messages.push(...next);
}

/**
 * Fila limitada: um job em voo; snapshot concorrente é descartado. Falha conta
 * no breaker e é engolida (o próximo turno retenta inline).
 */
export class BackgroundCompactor {
  readonly #dir: string;
  readonly #run: string;
  readonly #ledger: Ledger;
  readonly #audit: Auditor;
  #running: Promise<void> | undefined;
  #memory: { agent: string; job: BackgroundCompaction } | undefined;
  #closed = false;

  constructor(opts: BackgroundCompactorOptions) {
    this.#dir = opts.dir;
    this.#run = opts.run;
    this.#ledger = opts.ledger;
    this.#audit = opts.audit;
  }

  /** Agenda um snapshot; profundidade 1 (o segundo snapshot concorrente é perdido). */
  schedule(
    agent: string,
    messages: readonly ChatMessage[],
    work: (snapshot: readonly ChatMessage[]) => Promise<BackgroundCompactionResult>,
  ): void {
    if (this.#closed || this.#running !== undefined) return;
    const snapshot = cloneMessages(messages);
    const key = snapshotKey(snapshot);
    const count = snapshot.length;
    const task = (async () => {
      try {
        const result = await work(snapshot);
        if (result.olderCount === 0) return;
        const job: BackgroundCompaction = { ...result, snapshotKey: key, snapshotCount: count };
        this.#memory = { agent, job };
        try { this.#persist(agent, job); } catch { /* sem disco a memória ainda vale */ }
      } catch (error) {
        if (isAbortError(error)) return;
        try {
          recordCompactionFailure(this.#ledger, this.#run, agent);
          this.#audit.append({
            run: this.#run, agent, tipo: "compaction.failed",
            payload: { reason: "background", error: error instanceof Error ? error.name : "unknown" },
          });
        } catch { /* bookkeeping nunca vira unhandled rejection */ }
      }
    })();
    this.#running = task.finally(() => { this.#running = undefined; });
  }

  /** Consome o artefato pronto (memória ou disco) se ele casar com o prefixo atual. */
  take(agent: string, messages: readonly ChatMessage[]): BackgroundCompaction | undefined {
    const memory = this.#memory;
    if (memory?.agent === agent) {
      this.#memory = undefined;
      if (matches(memory.job, messages)) return memory.job;
    }
    const job = this.#load(agent);
    if (job === undefined) return undefined;
    this.#clear(agent);
    return matches(job, messages) ? job : undefined;
  }

  /** Aguarda a tarefa em voo (testes e encerramento limpo). */
  async drain(): Promise<void> {
    while (this.#running !== undefined) await this.#running;
  }

  /** Para de agendar e aguarda o que já está em voo; artefatos prontos ficam no disco. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#memory = undefined;
    await this.drain();
  }

  #persist(agent: string, job: BackgroundCompaction): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const { artifact, marker } = compactionArtifactPaths(this.#dir, this.#run, agent);
    const json = JSON.stringify({ schemaVersion: 1, run: this.#run, agent, ...job } satisfies Persisted);
    // Artefato primeiro, marcador depois: o leitor exige os dois.
    atomicWrite(artifact, json);
    const ready: Marker = {
      schemaVersion: 1,
      digest: createHash("sha256").update(json).digest("hex"),
      snapshotKey: job.snapshotKey,
      snapshotCount: job.snapshotCount,
    };
    atomicWrite(marker, JSON.stringify(ready));
  }

  #load(agent: string): BackgroundCompaction | undefined {
    const { artifact, marker } = compactionArtifactPaths(this.#dir, this.#run, agent);
    if (!existsSync(artifact) || !existsSync(marker)) return undefined;
    try {
      const raw = readFileSync(artifact, "utf8");
      const payload = JSON.parse(raw) as Persisted;
      const ready = JSON.parse(readFileSync(marker, "utf8")) as Marker;
      const valid = payload.schemaVersion === 1 && ready.schemaVersion === 1
        && payload.run === this.#run && payload.agent === agent
        && payload.artifact?.schemaVersion === 1 && payload.artifact.run === this.#run
        && ready.digest === createHash("sha256").update(raw).digest("hex")
        && ready.snapshotKey === payload.snapshotKey && ready.snapshotCount === payload.snapshotCount
        && Number.isInteger(payload.recentStart) && payload.recentStart >= 0
        && payload.recentStart <= payload.snapshotCount;
      if (!valid) return undefined;
      return {
        artifact: payload.artifact, reduction: payload.reduction,
        originalTokens: payload.originalTokens, returnedTokens: payload.returnedTokens,
        olderCount: payload.olderCount, recentStart: payload.recentStart,
        snapshotKey: payload.snapshotKey, snapshotCount: payload.snapshotCount,
      };
    } catch {
      return undefined; // parcial/corrompido: o turno cai no inline
    }
  }

  #clear(agent: string): void {
    const { artifact, marker } = compactionArtifactPaths(this.#dir, this.#run, agent);
    for (const path of [artifact, marker]) {
      try { unlinkSync(path); } catch { /* já consumido */ }
    }
  }
}
