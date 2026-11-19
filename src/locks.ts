/**
 * Operação de contas presas (#527): lista o lock reconstruído do ledger e libera
 * com auditoria. A fonte de verdade continua sendo o par `agent.created` /
 * `agent.destroyed` (A4, ADR-0009) — aqui não nasce arquivo de lock novo.
 */
import { activeLocks, releaseAgentLock, type PidProbe } from "./agent-lock";
import type { Auditor } from "./audit";
import { processAlive, type Ledger } from "./ledger";
import { redactSecrets } from "./sanitize-external";

/** Conta presa como o operador precisa vê-la: quem, qual conta, e se o dono está vivo. */
export interface LockSummary {
  run: string;
  agent_id: string;
  accountRef: string;
  provider?: string;
  model?: string;
  profile?: string;
  pid?: number;
  alive: boolean;
  /** `seq` do `agent.created` observado: guarda de concorrência do release (#527). */
  seq: number;
  created_at?: string;
  ageMs?: number;
}

/** Idade legível: `menos de 1 min`, `3h 41min`, `2d 5h`. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "menos de 1 min";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}min` : `${hours}h`;
  return `${rest}min`;
}

function ageOf(createdAt: string | undefined, now: number): number | undefined {
  if (createdAt === undefined) return undefined;
  const ts = Date.parse(createdAt);
  return Number.isNaN(ts) ? undefined : Math.max(0, now - ts);
}

/** Contas presas agora, com sonda de vida injetável (testes). */
export function summarizeLocks(
  ledger: Ledger,
  probe: PidProbe = processAlive,
  now: number = Date.now(),
): LockSummary[] {
  return activeLocks(ledger).map((lock) => {
    const ageMs = ageOf(lock.created_at, now);
    return {
      run: lock.run,
      agent_id: lock.agent_id,
      accountRef: lock.accountRef,
      ...(lock.provider === undefined ? {} : { provider: lock.provider }),
      ...(lock.model === undefined ? {} : { model: lock.model }),
      ...(lock.profile === undefined ? {} : { profile: lock.profile }),
      ...(lock.pid === undefined ? {} : { pid: lock.pid }),
      // Ledger legado sem pid não prova dono vivo: trata como não vivo.
      alive: lock.pid !== undefined && probe(lock.pid),
      seq: lock.seq,
      ...(lock.created_at === undefined ? {} : { created_at: lock.created_at }),
      ...(ageMs === undefined ? {} : { ageMs }),
    };
  });
}

function formatLockBlock(lock: LockSummary): string {
  const model = lock.model === undefined ? "?" : `${lock.provider ?? "?"}/${lock.model}`;
  const pid = lock.pid === undefined
    ? "desconhecido"
    : `${lock.pid} (${lock.alive ? "vivo" : "morto"})`;
  const age = lock.ageMs === undefined ? "" : `  há ${formatAge(lock.ageMs)}`;
  return [
    `  run     ${lock.run}  (agente ${lock.agent_id})`,
    `  conta   ${lock.accountRef}`,
    `  modelo  ${model}`,
    `  pid     ${pid}${age}`,
  ].join("\n");
}

/** Texto para o operador; sem valor de segredo (I-03) — só o nome da credencial. */
export function formatLocksList(locks: readonly LockSummary[]): string {
  if (locks.length === 0) return "nenhuma conta presa";
  const header = locks.length === 1 ? "1 conta presa" : `${locks.length} contas presas`;
  return `${header}:\n\n${locks.map(formatLockBlock).join("\n\n")}`;
}

export interface ReleaseLocksOptions {
  run: string;
  /** Desambigua runs com mais de um agente ativo. */
  agent?: string;
  /** Libera mesmo com o pid dono vivo (o dono pode continuar chamando até sair). */
  force?: boolean;
  probe?: PidProbe;
  now?: number;
}

export interface ReleaseLocksResult {
  released: boolean;
  /** Mensagem ao usuário: stdout quando liberou, stderr quando recusou. */
  message: string;
  locks: LockSummary[];
}

function describe(lock: LockSummary): string {
  const pid = lock.pid === undefined ? "" : `, pid ${lock.pid}`;
  return `run "${lock.run}", agente "${lock.agent_id}"${pid}`;
}

/**
 * Libera uma conta presa gravando `agent.destroyed` com `reason: manual_release`
 * (a mesma guarda pid/seq do recovery impede derrubar um lock readquirido).
 * Sem `--force` recusa quando o dono está vivo: o caso normal é outro run rodando.
 */
export function releaseLocks(
  ledger: Ledger,
  audit: Auditor,
  opts: ReleaseLocksOptions,
): ReleaseLocksResult {
  const probe = opts.probe ?? processAlive;
  // O ledger grava run/agent redigidos (I-03): compara do mesmo jeito (agent-lock `sameAgent`).
  const run = redactSecrets(opts.run);
  const agent = opts.agent === undefined ? undefined : redactSecrets(opts.agent);
  const candidates = summarizeLocks(ledger, probe, opts.now).filter(
    (lock) => lock.run === run && (agent === undefined || lock.agent_id === agent),
  );
  const alvo = agent === undefined ? `run "${run}"` : `run "${run}", agente "${agent}"`;
  if (candidates.length === 0) {
    return { released: false, locks: [], message: `nada para liberar: ${alvo} não tem conta presa` };
  }
  if (candidates.length > 1) {
    const ids = candidates.map((lock) => `"${lock.agent_id}"`).join(", ");
    return {
      released: false,
      locks: candidates,
      message: `recusado: run "${run}" tem ${candidates.length} contas presas; use --agent para escolher: ${ids}`,
    };
  }
  const lock = candidates[0] as LockSummary;
  const outcome = releaseObservedLock(ledger, audit, lock, { force: opts.force === true });
  return { ...outcome, locks: candidates };
}

export interface ReleaseObservedOptions {
  force?: boolean;
}

/**
 * Libera exatamente o lock observado (#527). A guarda `pid`/`seq` usa o
 * **snapshot** — reler o lock antes de escrever tornaria a guarda um no-op e
 * derrubaria um lock readquirido por outro processo no intervalo (A4).
 * `--force` com dono vivo audita `manual_release_forced`, distinto do caso morto.
 */
export function releaseObservedLock(
  ledger: Ledger,
  audit: Auditor,
  lock: LockSummary,
  opts: ReleaseObservedOptions = {},
): { released: boolean; message: string } {
  if (lock.alive && opts.force !== true) {
    return {
      released: false,
      message: `recusado: ${describe(lock)} ainda está vivo; use --force para liberar mesmo assim`,
    };
  }
  const forced = opts.force === true && lock.alive;
  const released = releaseAgentLock(ledger, audit, {
    run: lock.run,
    agent_id: lock.agent_id,
    reason: forced ? "manual_release_forced" : "manual_release",
    ...(lock.pid === undefined ? {} : { pid: lock.pid }),
    seq: lock.seq,
  });
  if (!released) {
    return {
      released: false,
      message: `nada foi liberado: a conta de ${describe(lock)} mudou desde a leitura; rode "astro locks" de novo`,
    };
  }
  return { released: true, message: `conta liberada: ${lock.accountRef} (${describe(lock)})` };
}
