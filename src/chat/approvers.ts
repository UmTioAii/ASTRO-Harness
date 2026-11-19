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
 * `s` vale para esta chamada; `S` grava um grant em memória até o fim da sessão.
 */
export function toolPrompt(request: ToolPermissionRequest): string {
  return `tool "${request.name}" (ação ${request.action}, modo ${request.mode}). [s] aprovar, [n] negar, [S] aprovar nesta sessão: `;
}

/**
 * Mapeia a resposta do prompt de tool (PERM-04, #265). `S` maiúsculo é sessão;
 * `s` minúsculo é aprovação única (true no gate). O vocabulário é exatamente o
 * do prompt: qualquer outra resposta nega (fail-closed, #546).
 */
export function toolChoice(answer: string | null): PermissionApproval {
  const raw = (answer ?? "").trim();
  if (raw === "S") return "session";
  if (raw === "s") return true;
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
      return toolChoice(answer);
    },
    trustAsk: async (cwd) => trustChoice(await ask(trustPrompt(cwd))),
  };
}
