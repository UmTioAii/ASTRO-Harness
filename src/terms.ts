/**
 * Termos de uso (#479): texto curto e versionado, aceito uma vez por versão e
 * registrado em `$ASTRO_HOME/state.json`. Sem rede: o texto vive no código.
 */
import { createInterface } from "node:readline";
import { statePath } from "./astro-home";
import { loadHomeState, saveHomeState, type TermsAcceptance } from "./home-state";

export type { TermsAcceptance };

/** Versão do texto; subir este número faz a próxima sessão interativa perguntar de novo. */
export const TERMS_VERSION = "1";

/** As cinco linhas mostradas no primeiro run. Fonte única do texto (o doc dono é `docs/terms.md`). */
export const TERMS_LINES: readonly string[] = [
  "O ASTRO roda na sua máquina; a conversa não é enviada a servidores do projeto.",
  "O conteúdo da conversa vai para o provider que você configurou e segue a política dele.",
  "Ferramentas executam com as permissões que você concede; revise cada aprovação.",
  "Tokens e chamadas de API são cobrados pelo provider, na sua conta.",
  "O software é fornecido no estado em que está, sem garantia de resultado.",
];

/** Aviso único de quem roda sem terminal interativo: segue, sem registrar aceite. */
export const TERMS_UNATTENDED_NOTICE = `termos de uso (versão ${TERMS_VERSION}) ainda não aceitos; sem terminal interativo, seguindo sem registrar aceite — leia os termos com /terms`;

/** Texto completo, uma linha por linha, sem numeração. */
export function termsText(): string {
  return TERMS_LINES.join("\n");
}

/** Pergunta do primeiro run: o texto inteiro e o contrato do Enter. */
export function termsPrompt(previous?: TermsAcceptance): string {
  const numbered = TERMS_LINES.map((line, index) => `  ${index + 1}. ${line}`);
  const header = previous === undefined
    ? `termos de uso (versão ${TERMS_VERSION}):`
    : `termos de uso (versão ${previous.version} → ${TERMS_VERSION}):`;
  return [
    header,
    ...numbered,
    "",
    `Enter aceita e registra a versão ${TERMS_VERSION}; qualquer outra resposta recusa e encerra: `,
  ].join("\n");
}

/** Só a linha vazia (Enter) aceita; espaço, outra resposta e EOF (`null`) recusam. */
export function termsChoice(answer: string | null | undefined): boolean {
  return answer === "";
}

/** Texto completo + estado do aceite, para o `/terms` da TUI e do REPL. */
export function formatTerms(record: TermsAcceptance | undefined): string {
  const status = record === undefined
    ? "ainda não aceito — o primeiro run interativo pede Enter"
    : `aceito em ${record.acceptedAt} (versão ${record.version})`;
  return termsWithStatus(status);
}

function termsWithStatus(status: string): string {
  return [`Termos de uso (versão ${TERMS_VERSION})`, "", termsText(), "", status].join("\n");
}

/**
 * `/terms` nunca lança (#591): estado ilegível vira aviso que cita só o caminho.
 * A mensagem do erro pode carregar o conteúdo do arquivo, então não é impressa (I-03).
 */
export function termsReport(path: string = statePath()): string {
  try {
    return formatTerms(loadTermsAcceptance(path));
  } catch {
    return termsWithStatus(`estado global ilegível em ${path} — não foi possível ler o aceite; corrija o arquivo ou apague o campo "terms"`);
  }
}

/** Registro aceito, ou `undefined` quando nunca houve aceite. Estado inválido é erro. */
export function loadTermsAcceptance(path: string = statePath()): TermsAcceptance | undefined {
  return loadHomeState(path).terms;
}

/** Grava o aceite preservando o resto do estado global (trust e migrações). */
export function saveTermsAcceptance(record: TermsAcceptance, path: string = statePath()): void {
  const state = loadHomeState(path);
  saveHomeState({ ...state, terms: { version: record.version, acceptedAt: record.acceptedAt } }, path);
}

/** Canal interativo injetável: `true` grava o aceite, `false` recusa. */
export type TermsAsk = (previous: TermsAcceptance | undefined) => boolean | Promise<boolean>;

export type TermsDecision =
  /** Versão corrente já aceita: não pergunta. */
  | { kind: "current"; record: TermsAcceptance }
  /** Aceito agora e gravado. */
  | { kind: "accepted"; record: TermsAcceptance }
  /** Recusado: nada foi gravado. */
  | { kind: "declined" }
  /** Sem canal interativo: segue sem perguntar e sem gravar. */
  | { kind: "unattended" };

export interface EnsureTermsOptions {
  /** Caminho do `state.json` (teste); default `statePath()`. */
  path?: string;
  /** Ausente = sem canal interativo (eval/CI, stdin em pipe). */
  ask?: TermsAsk;
  /** Relógio do teste; default `new Date()`. */
  now?: () => Date;
}

/**
 * Portão dos termos: já aceito nesta versão → `current`; versão diferente (ou
 * nenhuma) pergunta; sem canal interativo → `unattended`, sem gravar nada.
 * Recusa nunca escreve.
 */
export async function ensureTermsAccepted(opts: EnsureTermsOptions = {}): Promise<TermsDecision> {
  const path = opts.path ?? statePath();
  const current = loadTermsAcceptance(path);
  if (current?.version === TERMS_VERSION) return { kind: "current", record: current };
  if (opts.ask === undefined) return { kind: "unattended" };
  const accepted = await opts.ask(current);
  if (!accepted) return { kind: "declined" };
  const record: TermsAcceptance = {
    version: TERMS_VERSION,
    acceptedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  saveTermsAcceptance(record, path);
  return { kind: "accepted", record };
}

/** Canal de TTY dos termos; sem terminal interativo devolve `undefined` (nunca pergunta). */
export function ttyTermsAsk(): TermsAsk | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined;
  return async (previous) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      // EOF (Ctrl-D) recusa, como qualquer resposta diferente de Enter.
      const answer = await new Promise<string | null>((resolve) => {
        rl.once("close", () => resolve(null));
        rl.question(termsPrompt(previous), resolve);
      });
      return termsChoice(answer);
    } finally {
      rl.close();
    }
  };
}
