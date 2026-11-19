/** Model cards do Codex (#553). */
import type { ModelCard } from "../seed";

export const CODEX_MODELS: readonly ModelCard[] = [
  {
    id: "gpt-5.5",
    tags: ["writing-code", "tools", "reasoning"],
    context: 400000,
    status: "active",
    reasoning: true,
    // Codex usa o endpoint Responses.
    callMethod: "responses",
    // Escala do CLI: low/medium/high mapeiam para 1/2/3.
    efforts: ["1", "2", "3"],
    // Assinatura OAuth: sem preço por token.
    price: null,
    free: false,
  },
];
