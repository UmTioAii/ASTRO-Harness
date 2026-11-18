/** Header e footer da TUI (#480): uma linha cada, sem repetir informação. */
import { Text } from "ink";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import type { ThemeColors } from "./theme";

let cachedVersion: string | undefined;

/** Versão do pacote lida de package.json (cacheada em módulo); "desconhecida" se ilegível. */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { version?: unknown };
    cachedVersion = typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "desconhecida";
  } catch {
    cachedVersion = "desconhecida";
  }
  return cachedVersion;
}

/** Teto do header em colunas (#480). */
export const HEADER_WIDTH = 80;

export interface HeaderData {
  provider: string;
  /** Ref completa (`provider/modelo`) ou só o id; o provider é normalizado. */
  model: string;
  /** `ok`, `down` ou `n/d`. */
  health: string;
  /** Injetável em testes; default lê package.json. */
  version?: string;
}

/** `provider/modelo` como id do modelo, sem duplicar o prefixo do provider. */
function modelId(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

/** Corta no meio com `…`, preservando começo e fim. */
export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * Linha única do header (#480): versão, provider/modelo e saúde. O endpoint
 * fica em `/log`; nada de modo aqui (vive no footer).
 * Acima de 80 colunas corta o modelo e, se ainda faltar, o provider.
 */
export function headerLine(data: HeaderData): string {
  const prefix = `ASTRO v${data.version ?? packageVersion()} · `;
  const suffix = ` · ${data.health}`;
  const budget = Math.max(1, HEADER_WIDTH - prefix.length - suffix.length);
  let provider = data.provider;
  let model = modelId(data.model, data.provider);
  if (`${provider}/${model}`.length > budget) {
    model = truncateMiddle(model, Math.max(8, budget - provider.length - 1));
    if (`${provider}/${model}`.length > budget) {
      provider = truncateMiddle(provider, Math.max(1, budget - model.length - 1));
    }
  }
  return `${prefix}${provider}/${model}${suffix}`;
}

export interface FooterData {
  place: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  /** Segmento do budget já formatado (`budget: …`); ausente não aparece. */
  budget?: string;
}

/**
 * Footer (#480): só campos com valor. Sem turnos, sem tokens, sem custo
 * conhecido ou sem budget, o campo não aparece. O modo é anexado pelo
 * componente para receber cor.
 */
export function footerBase(data: FooterData): string {
  const parts = [data.place];
  if (data.turns > 0) parts.push(`${data.turns} turno(s)`);
  if (data.tokensIn + data.tokensOut > 0) parts.push(`${data.tokensIn}/${data.tokensOut} tokens`);
  if (data.costUsd !== null) parts.push(`US$ ${data.costUsd.toFixed(6)}`);
  if (data.budget !== undefined) parts.push(data.budget);
  return parts.join(" · ");
}

/** Cor do indicador de modo: só `bypass` usa alerta (#270). */
export function modeColor(mode: string | undefined, colors: ThemeColors): string | undefined {
  return mode === "bypass" ? colors.error : undefined;
}

/** Header renderizado: sem caixa; a cor segue a saúde (#480). */
export function Header({ colors, ...data }: HeaderData & { colors: ThemeColors }): ReactElement {
  const color = data.health === "down" ? colors.error : data.health === "n/d" ? undefined : colors.accent;
  return <Text color={color} dimColor={data.health === "n/d"}>{headerLine(data)}</Text>;
}
