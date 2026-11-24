/**
 * Boot do `astro chat` (#479): o portão dos termos roda antes do readline do
 * REPL. Dois `Interface` com `terminal: true` no mesmo stdin disputam o mesmo
 * chunk, e o `close()` do portão desliga o raw mode e pausa o stream — criar o
 * I/O depois do portão mantém um readline por vez (revisão A do PR #591).
 */
import { nodeReplIO, type NodeReplIO } from "./node-io";
import { ensureShellConsent, SHELL_CONSENT_DECLINED_NOTICE, type ShellConsentAsk } from "../shell-consent";
import { ensureTermsAccepted, type TermsAsk } from "../terms";
import { setShellConsent } from "../tools/run-command";

export type ChatBoot =
  /** Recusou: nada foi criado nem gravado. */
  | { kind: "declined" }
  /** Segue sem aceite (sem TTY); o I/O do REPL já existe. */
  | { kind: "unattended"; io: NodeReplIO }
  /** Versão corrente já aceita ou aceita agora; sessão pode abrir. */
  | { kind: "ready"; io: NodeReplIO };

export interface BootChatOptions {
  /** Caminho do `state.json`; default `statePath()`. */
  path?: string;
  /** Canal interativo; ausente = sem TTY (segue com aviso, sem aceite). */
  ask?: TermsAsk;
  /** Canal do consentimento de risco do shell (#599); ausente = sem TTY. */
  shellAsk?: ShellConsentAsk;
  /** Relógio do teste; default `new Date()`. */
  now?: () => Date;
  /** I/O do REPL; default `nodeReplIO()`. Teste injeta um sem tocar em `process.stdin`. */
  createIO?: () => NodeReplIO;
}

export async function bootChat(opts: BootChatOptions = {}): Promise<ChatBoot> {
  const terms = await ensureTermsAccepted({
    ...(opts.path === undefined ? {} : { path: opts.path }),
    ...(opts.ask === undefined ? {} : { ask: opts.ask }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  // Recusa sai antes de qualquer I/O: nenhum readline nasce para ser fechado.
  if (terms.kind === "declined") return { kind: "declined" };
  // #599: o risco do shell é reconhecido junto dos termos. Recusar não encerra o
  // app; desliga o shell da sessão e o próximo boot interativo pergunta de novo.
  const shell = await ensureShellConsent({
    ...(opts.path === undefined ? {} : { path: opts.path }),
    ...(opts.shellAsk === undefined ? {} : { ask: opts.shellAsk }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  if (shell.kind === "declined") console.error(SHELL_CONSENT_DECLINED_NOTICE);
  setShellConsent(shell.kind === "declined" ? "declined" : shell.kind === "unattended" ? "unrecorded" : "accepted");
  const io = (opts.createIO ?? nodeReplIO)();
  return terms.kind === "unattended" ? { kind: "unattended", io } : { kind: "ready", io };
}
