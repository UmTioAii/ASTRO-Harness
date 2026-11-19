/** Model cards do OpenRouter (#553). */
import type { ModelCard } from "../seed";

export const OPENROUTER_MODELS: readonly ModelCard[] = [
  {
    id: "openai/gpt-4o-mini",
    tags: ["writing-code", "tools", "fast"],
    context: 128000,
    status: "active",
    reasoning: false,
    callMethod: "chat-completions",
    efforts: [],
    // Preço de tabela do OpenRouter (USD/1M); curadoria pendente de conferência.
    price: {
      inputPerM: 0.15,
      outputPerM: 0.6,
      fonte: "https://openrouter.ai/openai/gpt-4o-mini",
      verificado: false,
    },
    free: false,
  },
];
