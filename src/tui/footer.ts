/** Status footer of the TUI (zone 4): only fields with a value, one line (#480, #595). */
import { packageVersion as manifestVersion } from "../version";
import type { ThemeColors } from "./theme";

let cachedVersion: string | undefined;

/** Version from `src/version.ts` (module cache); "desconhecida" when absent. */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  cachedVersion = manifestVersion() ?? "desconhecida";
  return cachedVersion;
}

export interface FooterData {
  place: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

/**
 * Footer (#480): only fields with a value. Tokens and known cost stay; the
 * conversation carries no turn, round or tool counter (#594). The model lives
 * in the timeline status zone, never here.
 */
export function footerBase(data: FooterData): string {
  const parts = [data.place];
  if (data.tokensIn + data.tokensOut > 0) parts.push(`${data.tokensIn}/${data.tokensOut} tokens`);
  if (data.costUsd !== null) parts.push(`US$ ${data.costUsd.toFixed(6)}`);
  return parts.join(" · ");
}

/** Mode indicator colour: only `bypass` warns (#270). */
export function modeColor(mode: string | undefined, colors: ThemeColors): string | undefined {
  return mode === "bypass" ? colors.error : undefined;
}

/** Budget segment colour (#480): ceiling in error, warning in yellow. */
export function budgetColor(
  budget: { warning: boolean; exhausted: boolean; ceilingHit: boolean },
  colors: ThemeColors,
): string | undefined {
  if (budget.exhausted || budget.ceilingHit) return colors.error;
  return budget.warning ? colors.warning : undefined;
}
