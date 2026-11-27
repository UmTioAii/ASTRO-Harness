import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/core/config";

function cfg(compaction?: unknown): Record<string, unknown> {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "http://p/v1", credentialRef: "P_KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: [] },
    ...(compaction === undefined ? {} : { compaction }),
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("config compaction (S-17, CMP-1, D-CFG1)", () => {
  test("ausente resolve para buffer null (default do ADR-0015)", () => {
    expect(validateConfig(cfg()).compaction).toEqual({ 
      buffer: null,
      maxRetries: 2,
      retryBackoffMs: 1000,
      summaryModel: undefined,
      summaryProvider: undefined,
    });
  });

  test("buffer expl�cito inteiro >= 0 � preservado", () => {
    expect(validateConfig(cfg({ buffer: 8_000 })).compaction).toEqual({ 
      buffer: 8_000,
      maxRetries: 2,
      retryBackoffMs: 1000,
      summaryModel: undefined,
      summaryProvider: undefined,
    });
    expect(validateConfig(cfg({ buffer: 0 })).compaction).toEqual({ 
      buffer: 0,
      maxRetries: 2,
      retryBackoffMs: 1000,
      summaryModel: undefined,
      summaryProvider: undefined,
    });
    expect(validateConfig(cfg({ buffer: null })).compaction).toEqual({ 
      buffer: null,
      maxRetries: 2,
      retryBackoffMs: 1000,
      summaryModel: undefined,
      summaryProvider: undefined,
    });
  });

  test("valores inv�lidos falham (non-discard)", () => {
    expect(() => validateConfig(cfg({ buffer: -1 }))).toThrow(/compaction.buffer/);
    expect(() => validateConfig(cfg({ buffer: 1.5 }))).toThrow(/compaction.buffer/);
    expect(() => validateConfig(cfg({ buffer: "8000" }))).toThrow(/compaction.buffer/);
    expect(() => validateConfig(cfg({ nope: true }))).toThrow(/compaction/);
    expect(() => validateConfig(cfg(8000))).toThrow(/compaction/);
  });

  test("novos campos opcionais s�o aceitos", () => {
    expect(validateConfig(cfg({ 
      summaryModel: "openai/gpt-4o-mini",
      summaryProvider: "openai",
      maxRetries: 3,
      retryBackoffMs: 2000,
    })).compaction).toEqual({
      buffer: null,
      summaryModel: "openai/gpt-4o-mini",
      summaryProvider: "openai",
      maxRetries: 3,
      retryBackoffMs: 2000,
    });
  });

  test("novos campos inv�lidos falham", () => {
    expect(() => validateConfig(cfg({ maxRetries: -1 }))).toThrow(/compaction.maxRetries/);
    expect(() => validateConfig(cfg({ maxRetries: 11 }))).toThrow(/compaction.maxRetries/);
    expect(() => validateConfig(cfg({ retryBackoffMs: -1 }))).toThrow(/compaction.retryBackoffMs/);
    expect(() => validateConfig(cfg({ retryBackoffMs: 60001 }))).toThrow(/compaction.retryBackoffMs/);
    expect(() => validateConfig(cfg({ summaryModel: "" }))).toThrow(/compaction.summaryModel/);
    expect(() => validateConfig(cfg({ summaryProvider: "" }))).toThrow(/compaction.summaryProvider/);
  });
});