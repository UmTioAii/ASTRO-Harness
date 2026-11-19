/**
 * Tool `todo_write` (F-17, #539): o plano do run deixa de ser prosa e passa a
 * ter forma estável que a sessão pode renderizar depois (T2) e que a auditoria
 * registra por contagem, nunca por texto (I-03).
 */
import { redactSecrets } from "../sanitize-external";
import type { AuditLike, Tool, ToolContext, ToolResult } from "./types";

export type TodoStatus = "pending" | "in_progress" | "done";

/** Vocabulário fechado de status do item. */
export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "done"];

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** Teto do plano: acima disso o run está usando a tool como bloco de notas. */
export const MAX_TODO_ITEMS = 50;
/** Teto de um item; o restante é cortado antes de voltar ao modelo. */
export const MAX_TODO_CONTENT_LENGTH = 200;
/** Código estável do erro de entrada (D-18: erro classificado, nunca `throw` cru). */
export const TODO_INVALID_INPUT = "invalid_input";

/**
 * Plano em memória, por run. Vive no processo que executa o run e nunca é
 * gravado em disco: sobrevive aos turnos da mesma sessão (o chat reusa o
 * `runId`) e não cruza runs, porque a chave é o `ctx.run` — um filho de `task`
 * tem run próprio e enxerga o próprio plano, vazio. O plano é do run, não do
 * agente: um run multi-agent (planner/coder) compartilha a mesma lista.
 */
export class TodoPlanStore {
  readonly #plans = new Map<string, readonly TodoItem[]>();

  get(run: string): readonly TodoItem[] {
    return this.#plans.get(run) ?? [];
  }

  /** Plano vazio não ocupa entrada: limpar libera a chave do run. */
  set(run: string, items: readonly TodoItem[]): void {
    if (items.length === 0) this.#plans.delete(run);
    else this.#plans.set(run, items);
  }

  clear(): void {
    this.#plans.clear();
  }
}

/** Erro de validação do input; convertido em `ToolResult` antes de sair da tool. */
class TodoInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnknownField(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

/**
 * Valida e sanitiza o plano inteiro antes de qualquer efeito: erro não muda
 * nada. Mensagens citam índice e campo, nunca o texto do item (I-03).
 */
function parsePlan(input: unknown): TodoItem[] {
  if (!isRecord(input)) {
    throw new TodoInputError('entrada inválida: esperado objeto { items: [...] }');
  }
  if (hasUnknownField(input, ["items"])) {
    throw new TodoInputError('entrada inválida: campo desconhecido (permitido apenas "items")');
  }
  const raw = input.items;
  if (!Array.isArray(raw)) {
    throw new TodoInputError('entrada inválida: "items" deve ser uma lista');
  }
  if (raw.length > MAX_TODO_ITEMS) {
    throw new TodoInputError(`plano grande demais: ${raw.length} itens (máximo ${MAX_TODO_ITEMS})`);
  }

  const items: TodoItem[] = [];
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const position = index + 1;
    if (!isRecord(value)) {
      throw new TodoInputError(`item ${position}: esperado objeto { content, status }`);
    }
    if (hasUnknownField(value, ["content", "status"])) {
      throw new TodoInputError(`item ${position}: campo desconhecido (permitidos: "content" e "status")`);
    }
    if (typeof value.content !== "string") {
      throw new TodoInputError(`item ${position}: "content" deve ser uma string`);
    }
    const trimmed = value.content.trim();
    if (trimmed.length === 0) {
      throw new TodoInputError(`item ${position}: "content" não pode ser vazio`);
    }
    if (trimmed.length > MAX_TODO_CONTENT_LENGTH) {
      throw new TodoInputError(`item ${position}: "content" excede ${MAX_TODO_CONTENT_LENGTH} caracteres`);
    }
    if (typeof value.status !== "string" || !(TODO_STATUSES as readonly string[]).includes(value.status)) {
      throw new TodoInputError(`item ${position}: "status" inválido (use "pending", "in_progress" ou "done")`);
    }
    // Redige antes de guardar: o plano alimenta a UI e o próximo prompt (I-03).
    const content = redactSecrets(trimmed).slice(0, MAX_TODO_CONTENT_LENGTH);
    if (seen.has(content)) {
      throw new TodoInputError(`item ${position}: "content" repete um item anterior`);
    }
    seen.add(content);
    items.push({ content, status: value.status as TodoStatus });
  });
  return items;
}

/** Contagem por status: é tudo o que a auditoria pode saber do plano (I-03). */
function countByStatus(items: readonly TodoItem[]): Record<string, number> {
  return {
    total: items.length,
    pending: items.filter((entry) => entry.status === "pending").length,
    in_progress: items.filter((entry) => entry.status === "in_progress").length,
    done: items.filter((entry) => entry.status === "done").length,
  };
}

export interface TodoWriteDeps {
  audit: AuditLike;
  /** Estado do run; injetado pela sessão para sobreviver aos turnos do chat. */
  store?: TodoPlanStore;
}

/**
 * Cria a tool com o plano do run em memória. Não escreve arquivo: por isso o
 * manifesto não entra em `.astro/`, não pede aprovação de escrita e o
 * confinamento de caminho (I-11) não tem o que restringir.
 */
export function createTodoWriteTool(deps: TodoWriteDeps): Tool {
  const store = deps.store ?? new TodoPlanStore();

  return {
    manifest: {
      name: "todo_write",
      description:
        "Substitui o plano do run por uma lista de itens {content, status: pending|in_progress|done}. " +
        "Devolve o plano atual com contagens; items: [] limpa. Não escreve arquivo.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            maxItems: MAX_TODO_ITEMS,
            description: `Plano completo do run (substitui o anterior; [] limpa). Máximo ${MAX_TODO_ITEMS} itens.`,
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: `O que precisa ser feito (até ${MAX_TODO_CONTENT_LENGTH} caracteres).`,
                },
                status: {
                  type: "string",
                  enum: [...TODO_STATUSES],
                  description: "Estado do item.",
                },
              },
              required: ["content", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
      risk: "low",
      permission: "read",
      class: "read_common",
      timeoutMs: 5_000,
      retryable: true,
      idempotent: true,
      sideEffects: "none",
    },

    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      try {
        const items = parsePlan(input);
        store.set(ctx.run, items);
        // Só contagens: o texto do item é saída do modelo e não vai para o audit.
        const counts = countByStatus(items);
        deps.audit.append({ run: ctx.run, agent: ctx.agent, tipo: "todo.updated", payload: { ...counts } });
        return { output: JSON.stringify({ ...counts, items }) };
      } catch (error) {
        // Só a validação é `invalid_input`; falha inesperada não se disfarça de entrada ruim.
        if (error instanceof TodoInputError) {
          return { output: `todo_write: ${redactSecrets(error.message)}`, isError: true, code: TODO_INVALID_INPUT };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { output: `todo_write: falha interna: ${redactSecrets(message)}`, isError: true };
      }
    },
  };
}
