/**
 * Buffer de log da sessão em memória (#514, docs/tui-layout.md §/log): ring de
 * linhas anexado pelos mesmos caminhos que antes imprimiam inline. Só memória —
 * a fonte durável continua sendo audit/ledger. Puro, sem I/O e sem React.
 */
import { sanitizePromptText } from "../sanitize-external";

/** Teto do buffer em linhas; acima disso as mais antigas são descartadas. */
export const LOG_CAP = 1000;

/**
 * Linha pronta para o buffer: sem segredo (I-03) e sem caractere invisível.
 * Usa a mesma regra canônica do prompt de aprovação (#536): C0/C1, bidi/Cf,
 * separadores e surrogate solto, com o strip antes da redação.
 */
export function sanitizeLogLine(line: string): string {
  return sanitizePromptText(line);
}

/**
 * Anexa `line` ao buffer (imutável): devolve um novo array com a linha
 * sanitizada, descartando as mais antigas acima de `cap`.
 */
export function appendLog(lines: readonly string[], line: string, cap: number = LOG_CAP): string[] {
  const next = [...lines, sanitizeLogLine(line)];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Últimas `n` linhas do buffer; sem `n`, o buffer inteiro. `n` fora de
 * inteiro ≥ 1 devolve vazio (o comando valida antes, isto é defesa em depth).
 */
export function tailLog(lines: readonly string[], n?: number): string[] {
  if (n === undefined) return [...lines];
  if (!Number.isInteger(n) || n < 1) return [];
  return lines.slice(Math.max(0, lines.length - n));
}

/** Cabeçalho da sessão exibido no topo do `/log`: versão, provider/modelo e endpoint. */
export function sessionHeaderLine(data: { version: string; model: string; endpoint: string }): string {
  return sanitizeLogLine(`ASTRO v${data.version} · ${data.model} · endpoint ${data.endpoint}`);
}

/** Lanes do buffer do /log (#560): cada linha carrega o prefixo `[lane]`. */
export type LogLane = "sessão" | "turno" | "saúde" | "aviso";

/**
 * Prefixa a linha com a lane para o `/log` mostrar as lanes separadas (#560).
 * A sanitização (I-03) continua sendo aplicada por `appendLog`.
 */
export function laneLine(lane: LogLane, line: string): string {
  return `[${lane}] ${line}`;
}
