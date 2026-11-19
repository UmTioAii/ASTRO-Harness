/** Model cards da NVIDIA NIM (#553). */
import type { ModelCard } from "../seed";

export const NVIDIA_MODELS: readonly ModelCard[] = [
  {
    id: "meta/llama-3.3-70b-instruct",
    tags: ["writing-code", "tools", "long-context"],
    context: 131072,
    status: "active",
    // Llama 3.3 é instruct, não reasoning: sem effort configurável.
    reasoning: false,
    callMethod: "chat-completions",
    efforts: [],
    // NIM não publica preço por token; sem curadoria o custo fica `n/d` (D-10).
    price: null,
    free: false,
  },
];
