import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SLICE_MAPPING,
  formatSliceReport,
  parseLcov,
  sliceCoverage,
} from "../scripts/coverage-gate";

const lcov = [
  "TN:",
  "SF:src/a.ts",
  "FNF:2",
  "FNH:2",
  "LF:10",
  "LH:10",
  "end_of_record",
  "SF:src/b.ts",
  "FNF:2",
  "FNH:1",
  "LF:10",
  "LH:5",
  "end_of_record",
].join("\n");

function record(file: string, lh: number, lf: number, fnh = 0, fnf = 0): string[] {
  return [
    `SF:${file}`,
    `FNF:${fnf}`,
    `FNH:${fnh}`,
    `LF:${lf}`,
    `LH:${lh}`,
    "end_of_record",
  ];
}

describe("coverage gate (#59)", () => {
  test("soma linhas e funções e aprova no threshold", () => {
    const totals = parseLcov(lcov, 0.75);
    expect(totals.lines).toEqual({ hit: 15, found: 20, rate: 0.75 });
    expect(totals.functions).toEqual({ hit: 3, found: 4, rate: 0.75 });
    expect(totals.ok).toBe(true);
  });

  test("reprova quando linhas ou funções ficam abaixo", () => {
    expect(parseLcov(lcov, 0.8).ok).toBe(false);
    expect(parseLcov(lcov, 0.76).ok).toBe(false);
  });

  test("limiar exato aprova e um passo abaixo reprova", () => {
    const exact = record("src/a.ts", 8, 10, 4, 5).join("\n");
    expect(parseLcov(exact, 0.8).ok).toBe(true);
    expect(parseLcov(record("src/a.ts", 79, 100, 4, 5).join("\n"), 0.8).ok).toBe(false);
  });

  test("lcov vazio falha fechado", () => {
    const totals = parseLcov("", 0.8);
    expect(totals.ok).toBe(false);
    expect(totals.lines.rate).toBe(0);
    expect(totals.functions.rate).toBe(0);
  });

  test("ignora linhas malformadas", () => {
    const totals = parseLcov("LF:abc\nLH:1\nFNF:2\nFNH:1\nSF:x\nend_of_record", 0.5);
    expect(totals.lines.hit).toBe(1);
    expect(totals.lines.found).toBe(0);
    expect(totals.ok).toBe(false);
  });
});

describe("sliceCoverage (#59)", () => {
  const text = [
    ...record("src/skills/loader.ts", 9, 10, 1, 2),
    ...record("src/skill-registry.ts", 1, 2),
    ...record("src/mcp/client.ts", 4, 4, 1, 1),
    ...record("src/tools/web-fetch.ts", 0, 5),
    ...record("src/core/session.ts", 7, 8, 3, 4),
    ...record("src/handoff/plan.ts", 2, 2),
    ...record("src/ledger.ts", 10, 10),
  ].join("\n");

  test("soma por slice e separa o bucket unmapped", () => {
    const slices = sliceCoverage(text, SLICE_MAPPING);
    const byName = Object.fromEntries(slices.map((slice) => [slice.slice, slice]));
    expect(byName["C1 skills"]?.files).toBe(2);
    expect(byName["C1 skills"]?.lines).toEqual({ hit: 10, found: 12, rate: 10 / 12 });
    expect(byName["C2 mcp"]?.lines).toEqual({ hit: 4, found: 4, rate: 1 });
    expect(byName["C3 web"]?.functions.found).toBe(0);
    expect(byName["C4 multi-agent"]?.files).toBe(2);
    expect(byName["C4 multi-agent"]?.functions).toEqual({ hit: 3, found: 4, rate: 0.75 });
    expect(byName.unmapped?.files).toBe(1);
    expect(byName.unmapped?.lines.hit).toBe(10);
    expect(slices.map((slice) => slice.slice)).toEqual([
      "C1 skills",
      "C2 mcp",
      "C3 web",
      "C4 multi-agent",
      "unmapped",
    ]);
  });

  test("slice sem registros não quebra e imprime n/a", () => {
    const slices = sliceCoverage(record("src/ledger.ts", 1, 1).join("\n"), SLICE_MAPPING);
    const web = slices.find((slice) => slice.slice === "C3 web");
    expect(web).toEqual({ slice: "C3 web", files: 0, lines: { hit: 0, found: 0, rate: 0 }, functions: { hit: 0, found: 0, rate: 0 } });
    const report = formatSliceReport(slices).join("\n");
    expect(report).toContain("n/a");
    expect(report).toContain("informativo");
  });

  test("normaliza separador win32 e aceita mapping customizado", () => {
    const slices = sliceCoverage([
      ...record("src\\mcp\\client.ts", 1, 2),
      ...record("C:/repo/src/mcp/server.ts", 1, 1),
      ...record("tests/mcp.test.ts", 0, 1),
    ].join("\n"), { "C2 mcp": ["src/mcp"] });
    expect(slices[0]?.files).toBe(2);
    expect(slices[0]?.lines).toEqual({ hit: 2, found: 3, rate: 2 / 3 });
    expect(slices[1]?.slice).toBe("unmapped");
    expect(slices[1]?.files).toBe(1);
  });
});

describe("coverage gate CLI (#59)", () => {
  const root = join(import.meta.dir, "..");
  const script = join(root, "scripts", "coverage-gate.ts");

  function run(args: string[]) {
    const result = Bun.spawnSync([process.execPath, script, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  test("imprime a tabela por slice e sai 0 acima do limiar", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-cov-"));
    try {
      const passing = join(dir, "pass.info");
      writeFileSync(passing, [...record("src/skills/loader.ts", 10, 10, 2, 2)].join("\n"));
      const result = run(["--file", passing]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("C1 skills");
      expect(result.stdout).toContain("100.00%");
      expect(result.stdout).toContain("unmapped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sai 1 abaixo do limiar e ainda imprime a tabela", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-cov-"));
    try {
      const failing = join(dir, "fail.info");
      writeFileSync(failing, [...record("src/mcp/client.ts", 1, 10, 0, 2)].join("\n"));
      const result = run(["--file", failing, "--threshold", "0.8"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("C2 mcp");
      expect(result.stderr).toContain("abaixo do threshold");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
