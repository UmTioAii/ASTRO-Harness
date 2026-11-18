/**
 * Preço de modelo em três estados (#476, #511): `grátis` (FREE, ADR-0025),
 * preço curado `in X/M out Y/M (fonte[, não verificado])`, ou `n/d` quando
 * desconhecido. Puro, sem I/O; usado por ledger, catálogo e TUI.
 */
import type { PriceConfig } from "./core/config";

/** Modelo marcado como gratuito (ADR-0025): slug `:free` no id/ref ou preço curado 0/0. */
export function isFreeModel(model: string, price?: PriceConfig): boolean {
  return model.endsWith(":free")
    || (price !== undefined && price.inputPerM === 0 && price.outputPerM === 0);
}

/**
 * Rótulo do preço para cards e listas (#511): FREE renderiza `grátis` e nunca
 * cai em `n/d`; sem preço curado é `n/d`; com preço é `in X/M out Y/M (fonte[, não verificado])`.
 */
export function priceLabel(model: string, price?: PriceConfig): string {
  if (isFreeModel(model, price)) return "grátis";
  if (price === undefined) return "n/d";
  return `in ${price.inputPerM}/M out ${price.outputPerM}/M (${price.fonte}${price.verificado ? "" : ", não verificado"})`;
}
