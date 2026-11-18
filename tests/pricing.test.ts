import { describe, expect, test } from "bun:test";
import { isFreeModel, priceLabel } from "../src/pricing";

describe("pricing (#476 FREE, #511 cards)", () => {
  test("isFreeModel: slug :free no id ou preço curado 0/0", () => {
    expect(isFreeModel("llama:free")).toBe(true);
    expect(isFreeModel("m", { inputPerM: 0, outputPerM: 0, fonte: "t", verificado: true })).toBe(true);
    expect(isFreeModel("m")).toBe(false);
    expect(isFreeModel("m", { inputPerM: 1, outputPerM: 0, fonte: "t", verificado: true })).toBe(false);
    expect(isFreeModel("m", { inputPerM: 0, outputPerM: 1, fonte: "t", verificado: true })).toBe(false);
    expect(isFreeModel("free", undefined)).toBe(false); // slug precisa do sufixo ":free"
  });

  test("priceLabel: três estados — grátis, preço curado, n/d (nunca n/d para FREE)", () => {
    expect(priceLabel("llama:free")).toBe("grátis");
    expect(priceLabel("m", { inputPerM: 0, outputPerM: 0, fonte: "t", verificado: true })).toBe("grátis");
    expect(priceLabel("m", { inputPerM: 1, outputPerM: 2, fonte: "t", verificado: true }))
      .toBe("in 1/M out 2/M (t)");
    expect(priceLabel("m", { inputPerM: 1, outputPerM: 2, fonte: "t", verificado: false }))
      .toBe("in 1/M out 2/M (t, não verificado)");
    expect(priceLabel("m")).toBe("n/d");
  });

  test("priceLabel converge com o ledger: :free com preço curado não-zero mostra o preço, não grátis", () => {
    // ledger: estimateCost(…, price não-zero) ?? … → cobra o preço; o card não pode dizer grátis
    expect(priceLabel("x:free", { inputPerM: 5, outputPerM: 10, fonte: "t", verificado: true }))
      .toBe("in 5/M out 10/M (t)");
    expect(priceLabel("x:free", { inputPerM: 5, outputPerM: 10, fonte: "t", verificado: true }))
      .not.toBe("grátis");
  });
});
