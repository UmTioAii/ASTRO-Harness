/**
 * I-03: varredura determinística por segredos em artefatos.
 *
 * Cobre o repo versionado (fontes, docs, config de exemplo, fixtures) e os
 * artefatos que o harness grava (audit, ledger e log). Fixtures de redação só
 * passam quando o valor tem marca óbvia de teste; um segredo real não tem.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import { redactSecrets } from "../src/sanitize-external";

const ROOT = resolve(import.meta.dir, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".astro", ".sdd", "logs"]);
const TEXT_FILE = /\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|txt|log|ya?ml|toml|lock|example|cfg|ini|sh|ps1)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

/** Formatos de chave conhecidos; o valor nunca sai no relatório (I-03). */
const KEY_PATTERNS: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "openai", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/g },
  { rule: "github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { rule: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "google", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { rule: "slack", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { rule: "gitlab", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { rule: "nvidia", pattern: /\bnvapi-[A-Za-z0-9_-]{12,}/g },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { rule: "pem", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: "bearer", pattern: /\bBearer[ \t]+[A-Za-z0-9+/=._-]{12,}/g },
];

/**
 * Allowlist de fixtures de redação: só valores com marca inequívoca de teste.
 * A varredura continua ativa em todo arquivo (inclusive testes); o que muda é
 * o valor sintético, não o caminho. Gitleaks cobre o resto no CI.
 */
const FIXTURE_ALLOWLIST: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /example|sample|placeholder/i, reason: "chave de exemplo publicada" },
  { pattern: /(?:^|[^a-z])(?:test|fake|dummy)/i, reason: "valor sintético de teste" },
  { pattern: /sentinel|segredo|secret|do-not-store|not-a-real/i, reason: "sentinela de redação" },
  { pattern: /abcdef|123456789/i, reason: "sequência usada como fixture" },
];

interface Hit {
  rule: string;
  index: number;
}

interface Finding extends Hit {
  file: string;
  line: number;
}

/** Um arquivo fixture de redação? Só o valor é dispensado, nunca o arquivo. */
function isAllowedFixture(value: string): boolean {
  return FIXTURE_ALLOWLIST.some((entry) => entry.pattern.test(value));
}

/** Casa os formatos de chave; devolve só a regra e a posição (sem o valor). */
export function scanText(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const { rule, pattern } of KEY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      // `match.index` é sempre definido em matchAll; o guard mantém o tipo honesto.
      const index = match.index ?? 0;
      if (!isAllowedFixture(match[0])) hits.push({ rule, index });
    }
  }
  return hits.sort((a, b) => a.index - b.index || a.rule.localeCompare(b.rule));
}

/** Arquivos de texto do repo, ordenados para a varredura ser determinística. */
function repoFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // não segue para fora do repo
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) repoFiles(path, out);
      continue;
    }
    if (TEXT_FILE.test(entry.name) && statSync(path).size <= MAX_BYTES) out.push(path);
  }
  return out;
}

/** Varre o repo inteiro; a mensagem cita arquivo:linha e regra, nunca o valor. */
function scanRepo(): Finding[] {
  const findings: Finding[] = [];
  for (const path of repoFiles(ROOT).sort()) {
    const text = readFileSync(path, "utf8");
    if (text.includes("\u0000")) continue; // binário disfarçado de texto
    for (const hit of scanText(text)) {
      findings.push({
        file: relative(ROOT, path).replaceAll("\\", "/"),
        line: text.slice(0, hit.index).split("\n").length,
        ...hit,
      });
    }
  }
  return findings;
}

/** Segredo sintético construído em runtime: nenhum literal de chave no diff. */
function syntheticKey(): string {
  return ["s", "k", "-", "proj", "7Qm4Zx9Lk2Vb8Rt5"].join("");
}

describe("I-03 zero segredos", () => {
  test("detector reconhece chave sintética e ignora redação/fixture", () => {
    const key = syntheticKey();
    expect(scanText(`chave ${key} no log`).map((hit) => hit.rule)).toEqual(["openai"]);
    expect(scanText("[REDACTED]")).toEqual([]);
    expect(scanText(`${key}-do-not-store`)).toEqual([]); // allowlist de fixture
  });

  test("repo versionado não tem chave real em fonte, doc, config ou fixture", () => {
    const findings = scanRepo();
    expect(findings.map((finding) => `${finding.file}:${finding.line} (${finding.rule})`)).toEqual([]);
  });

  test("audit, ledger e log gerados não contêm o segredo", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-zero-secret-"));
    const secret = syntheticKey();
    const audit = new Auditor(join(dir, "audit.jsonl"));
    audit.append({
      run: "r1",
      tipo: "probe",
      payload: {
        apiKey: secret,
        nested: { authorization: `Bearer ${secret}` },
        output: `token=${secret}`,
        note: "ok",
      },
    });
    const ledger = new Ledger(join(dir, "ledger.jsonl"), { warn: () => {} });
    ledger.recordBudgetReserved({ run: "r1", agent: `agent-${secret}`, reserved: 0.1, detail: `fallback: ${secret}` });
    const logPath = join(dir, "astro.log");
    writeFileSync(logPath, `${redactSecrets(`provider falhou: ${secret}`)}\n`);

    for (const file of ["audit.jsonl", "ledger.jsonl", "astro.log"]) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toContain(secret);
      expect(scanText(text)).toEqual([]);
    }
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toContain("[REDACTED]");
  });

  test("varredura é determinística", () => {
    expect(scanRepo()).toEqual(scanRepo());
  });
});
