/** Interactive deciders for chat (TTY): same readline as the REPL, no extra TTY. */
import type { SwapApprover, SwapRequest } from "../approval";
import type { BudgetDecider, BudgetStatus } from "../budget";
import type { PermissionApproval, ToolPermissionRequest } from "../permissions";
import { trustChoice, trustPrompt, type TrustAsk } from "../trust";
import type { ToolApprover } from "../tools/executor";
import type { ReplIO } from "./repl";

export function isYes(answer: string | null): boolean {
  return answer !== null && /^(s|sim|y|yes)$/i.test(answer.trim());
}

export function budgetChoice(answer: string | null): "continue_same" | "lower_effort" | "stop" {
  const choice = (answer ?? "").trim().toLowerCase();
  if (choice === "c" || choice === "continuar" || choice === "continue") return "continue_same";
  if (choice === "l" || choice === "baixar" || choice === "lower") return "lower_effort";
  return "stop";
}

export function swapPrompt(request: SwapRequest): string {
  const from = `${request.from.provider}/${request.from.model ?? "?"}`;
  const to = `${request.to.provider}/${request.to.model ?? "?"}`;
  const cost = request.costDeltaUsd === undefined || request.costDeltaUsd === null
    ? ""
    : `; custo delta US$${request.costDeltaUsd.toFixed(2)}/1M`;
  return `troca ${from} -> ${to} (${request.reason}${cost}). aprovar? [s/N] `;
}

export function budgetPrompt(status: BudgetStatus): string {
  const limit = status.limitUsd === null ? "sem limite" : `US$ ${status.limitUsd}`;
  return `budget esgotado (${status.estimate} / ${limit}). [c] continuar, [l] baixar, [p] parar: `;
}

/**
 * Prompt de aprovação de tool/file (PERM-04, #265): três opções na mesma linha.
 * `s` vale para esta chamada; `a` (ou `S`, por compatibilidade) grava um grant
 * na sessão — no shell do host vira uma regra de prefixo salva no projeto
 * (#599). O argumento material (`request.detail`, #536) entra entre parênteses:
 * sem ele o prompt é exatamente o antigo. Quando a ação exige aprovação por
 * chamada (#474, shell no host), `always` não é oferecido: o host pergunta a
 * cada execução, então a opção seria ignorada.
 */
export function toolPrompt(request: ToolPermissionRequest): string {
  const detail = request.detail === undefined
    ? ""
    : `, ${request.detail.kind === "command" ? "comando" : "caminho"} \`${request.detail.value}\``;
  const choices = request.perCall === true
    ? "[s] once, [a] always (saves a prefix rule), [r] reject, [n] deny"
    : "[s] once, [a] always, [r] reject, [n] deny";
  return `tool "${request.name}" (ação ${request.action}, modo ${request.mode}${detail}). ${choices}: `;
}

/**
 * Mapeia a resposta do prompt de tool (PERM-04, #265, #599). `s`/`once` aprova
 * uma vez; `a`/`always` aprova sempre (regra salva no shell, grant na sessão);
 * `S` é o sinônimo legado, mas em `perCall` fica limitado à chamada — só
 * `always` pode gravar a camada de projeto; `r`/`reject` nega e cancela as
 * aprovações pendentes da sessão. Qualquer outra resposta nega (fail-closed,
 * #546).
 */
export function toolChoice(answer: string | null, perCall = false): PermissionApproval {
  const raw = (answer ?? "").trim();
  const word = raw.toLowerCase();
  if (word === "a" || word === "always") return "always";
  if (raw === "S") return perCall ? true : "always";
  if (raw === "s" || word === "once") return "once";
  if (word === "r" || word === "reject") return "reject";
  return false;
}

export function chatApprovers(
  io: ReplIO,
  interactive: boolean,
): { approveSwap?: SwapApprover; onBudgetExceeded?: BudgetDecider; approveTool?: ToolApprover; trustAsk?: TrustAsk } {
  if (!interactive) return {};
  const ask = (prompt: string): Promise<string | null> => (io.readFresh ?? io.read).call(io, prompt);
  return {
    approveSwap: async (request) => isYes(await ask(swapPrompt(request))),
    onBudgetExceeded: async (status) => budgetChoice(await ask(budgetPrompt(status))),
    // #526: a aprovação de tool é a única espera cancelável (timeout/abort do gate).
    approveTool: async (request, wait) => {
      const prompt = toolPrompt(request);
      // Com `readCancelable` a espera sai da fila no abort/timeout. IOs antigos,
      // sem o método, mantêm a leitura simples: não há como remover o waiter,
      // então uma linha tardia pode ser perdida — só o node-io real cancela.
      const answer = io.readCancelable !== undefined
        ? await io.readCancelable(prompt, wait?.signal)
        : await ask(prompt);
      // #526: a pergunta saiu da fila sem resposta. Fecha a linha do prompt (o
      // texto seguinte não cola nela) e nomeia o limite quando houve timeout.
      if (answer === null && io.readCancelable !== undefined) {
        const notice = wait?.timedOut === true && wait.timeoutMs !== undefined
          ? `aprovação de "${request.name}" expirada após ${wait.timeoutMs}ms`
          : `aprovação de "${request.name}" cancelada sem resposta`;
        // `write` do node-io já fecha a linha: só o break inicial separa do prompt.
        io.write(`\n${notice}`);
      }
      return toolChoice(answer, request.perCall === true);
    },
    trustAsk: async (cwd) => trustChoice(await ask(trustPrompt(cwd))),
  };
}
