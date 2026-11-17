#!/usr/bin/env bun
/**
 * Gate de cobertura (#59): totais de linhas/funções do lcov + relatório por
 * slice das funcionalidades C1–C4.
 *
 * O threshold do Bun é por arquivo, então UI parcialmente coberta derrubaria o
 * total; por isso o gate soma LF/LH e FNF/FNH de todos os registros.
 *
 * Exit code: só os totais decidem (fail-closed: abaixo do threshold ou lcov
 * vazio/sem métricas). O relatório por slice é informativo e nunca altera o
 * exit code; slice sem registros imprime `n/a` em vez de quebrar.
 *
 * Mapa de slices (`SLICE_MAPPING`): cada chave é um slice, cada valor uma lista
 * de padrões de caminho de `SF:` do lcov. Casamento, na ordem da lista:
 * - `dir` casa `dir` e `dir/...`;
 * - `prefixo*` casa qualquer caminho que comece por `prefixo`.
 * O primeiro match vence; caminho sem match cai em `unmapped`.
 *
 * Para adicionar um slice: inclua a chave/lista em `SLICE_MAPPING`, um caso em
 * `tests/coverage-gate.test.ts` e nada mais.
 *
 * Uso: `bun scripts/coverage-gate.ts [--file coverage/lcov.info] [--threshold 0.8]`
 * (o caminho e o threshold posicionais antigos continuam aceitos).
 */
import { readFileSync } from "node:fs";

export interface CoverageMetric {
  hit: number;
  found: number;
  rate: number;
}

export interface CoverageTotals {
  lines: CoverageMetric;
  functions: CoverageMetric;
  ok: boolean;
}

export interface SliceCoverage {
  slice: string;
  files: number;
  lines: CoverageMetric;
  functions: CoverageMetric;
}

export type SliceMapping = Readonly<Record<string, readonly string[]>>;

export const UNMAPPED_SLICE = "unmapped";

/** Slices C1–C4; ver cabeçalho para a semântica dos padrões. */
export const SLICE_MAPPING: SliceMapping = {
  "C1 skills": ["src/skills", "src/skill*"],
  "C2 mcp": ["src/mcp"],
  "C3 web": ["src/web-*", "src/tools/web*"],
  "C4 multi-agent": [
    "src/core/session.ts",
    "src/core/app.ts",
    "src/loop-guard.ts",
    "src/handoff*",
  ],
};

function metric(hit: number, found: number): CoverageMetric {
  return { hit, found, rate: found === 0 ? 0 : hit / found };
}

/** Soma os registros lcov; lcov vazio ou sem métricas falha fechado. */
export function parseLcov(text: string, threshold = 0.8): CoverageTotals {
  let lineHit = 0;
  let lineFound = 0;
  let fnHit = 0;
  let fnFound = 0;

  for (const raw of text.split(/\r?\n/)) {
    const separator = raw.indexOf(":");
    if (separator <= 0) continue;
    const key = raw.slice(0, separator);
    const value = Number(raw.slice(separator + 1).trim());
    if (!Number.isFinite(value)) continue;
    if (key === "LH") lineHit += value;
    else if (key === "LF") lineFound += value;
    else if (key === "FNH") fnHit += value;
    else if (key === "FNF") fnFound += value;
  }

  const lines = metric(lineHit, lineFound);
  const functions = metric(fnHit, fnFound);
  const ok = lines.found > 0
    && functions.found > 0
    && lines.rate >= threshold
    && functions.rate >= threshold;
  return { lines, functions, ok };
}

/** Normaliza `SF:` para caminho relativo à raiz, aceitando `\` e absoluto. */
function normalizePath(file: string): string {
  const slashed = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const marker = slashed.lastIndexOf("/src/");
  return marker === -1 ? slashed : slashed.slice(marker + 1);
}

function matchesPath(pattern: string, file: string): boolean {
  if (pattern.endsWith("*")) return file.startsWith(pattern.slice(0, -1));
  return file === pattern || file.startsWith(`${pattern}/`);
}

interface Bucket {
  files: number;
  lineHit: number;
  lineFound: number;
  fnHit: number;
  fnFound: number;
}

function emptyBucket(): Bucket {
  return { files: 0, lineHit: 0, lineFound: 0, fnHit: 0, fnFound: 0 };
}

/** Agrega os registros `SF:` por slice; informações, não decide o gate. */
export function sliceCoverage(text: string, mapping: SliceMapping = SLICE_MAPPING): SliceCoverage[] {
  const names = Object.keys(mapping);
  const buckets = new Map<string, Bucket>(names.map((name) => [name, emptyBucket()]));
  buckets.set(UNMAPPED_SLICE, emptyBucket());

  let target: Bucket | null = null;

  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "end_of_record") {
      target = null;
      continue;
    }
    const separator = raw.indexOf(":");
    if (separator <= 0) continue;
    const key = raw.slice(0, separator);
    const rawValue = raw.slice(separator + 1).trim();
    if (key === "SF") {
      if (rawValue.length === 0) {
        target = null;
        continue;
      }
      const path = normalizePath(rawValue);
      const name = names.find((candidate) =>
        (mapping[candidate] ?? []).some((pattern) => matchesPath(pattern, path))) ?? UNMAPPED_SLICE;
      target = buckets.get(name) ?? null;
      if (target !== null) target.files += 1;
      continue;
    }
    if (target === null) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (key === "LH") target.lineHit += value;
    else if (key === "LF") target.lineFound += value;
    else if (key === "FNH") target.fnHit += value;
    else if (key === "FNF") target.fnFound += value;
  }

  return [...buckets].map(([slice, value]) => ({
    slice,
    files: value.files,
    lines: metric(value.lineHit, value.lineFound),
    functions: metric(value.fnHit, value.fnFound),
  }));
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function rateLabel(value: CoverageMetric): string {
  return value.found === 0 ? "n/a" : percent(value.rate);
}

/** Tabela textual do relatório por slice (informativo). */
export function formatSliceReport(slices: readonly SliceCoverage[]): string[] {
  const header = ["slice", "lines", "functions", "lines hit/found", "files"];
  const rows = slices.map((slice) => slice.files === 0
    ? [slice.slice, "n/a", "n/a", "n/a", "0"]
    : [
        slice.slice,
        rateLabel(slice.lines),
        rateLabel(slice.functions),
        `${slice.lines.hit}/${slice.lines.found}`,
        String(slice.files),
      ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const render = (cells: readonly string[]) =>
    cells.map((cell, index) => index === 0
      ? cell.padEnd(widths[index] ?? cell.length)
      : cell.padStart(widths[index] ?? cell.length)).join("  ");

  return [
    "coverage por slice (informativo, não altera o exit code):",
    render(header),
    ...rows.map(render),
  ];
}

interface CliOptions {
  file: string;
  threshold: number;
}

/** Aceita `--file`/`--threshold` e a forma posicional antiga. */
function parseArgs(argv: readonly string[]): CliOptions {
  let file = "coverage/lcov.info";
  let threshold = 0.8;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--file" && argv[index + 1] !== undefined) {
      file = argv[index + 1] ?? file;
      index += 1;
    } else if (arg === "--threshold" && Number.isFinite(Number(argv[index + 1]))) {
      threshold = Number(argv[index + 1]);
      index += 1;
    } else {
      positional.push(arg);
    }
  }

  if (positional[0] !== undefined) file = positional[0];
  if (positional[1] !== undefined && Number.isFinite(Number(positional[1]))) {
    threshold = Number(positional[1]);
  }
  return { file, threshold };
}

if (import.meta.main) {
  const { file, threshold } = parseArgs(process.argv.slice(2));
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`coverage: lcov não encontrado em ${file}`);
    process.exit(1);
  }
  const totals = parseLcov(text, threshold);
  console.log(
    `coverage: ${percent(totals.lines.rate)} linhas (${totals.lines.hit}/${totals.lines.found}) · ` +
    `${percent(totals.functions.rate)} funções (${totals.functions.hit}/${totals.functions.found}) · ` +
    `threshold ${percent(threshold)}`,
  );
  for (const line of formatSliceReport(sliceCoverage(text, SLICE_MAPPING))) console.log(line);
  if (!totals.ok) {
    console.error("coverage: abaixo do threshold");
    process.exit(1);
  }
}
