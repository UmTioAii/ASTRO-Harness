import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { resolveWithin } from "../src/tools/paths";
import { readFileTool } from "../src/tools/read-file";
import type { Tool, ToolResult } from "../src/tools/types";
import { writeFileTool } from "../src/tools/write-file";
import { installDockerSpawnMock, isolatedRunCommand, type DockerMock } from "./helpers/docker-mock";

const dir = () => mkdtempSync(join(tmpdir(), "astro-tools-"));
const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "default" });
let mod: typeof import("../src/tools/run-command");
let mock: DockerMock;
let seq = 0;
const mkExec = (cwd: string) => {
  const tools = [readFileTool, writeFileTool, mod.runCommandTool];
  return new ToolExecutor({ approveTool: () => true, tools, allow: tools.map((t) => t.manifest.name), audit: new Auditor(join(cwd, ".astro", "audit.jsonl")) });
};

// Estes testes executam shell só no sandbox (mock de docker, módulo isolado):
// slice 4b — o host nunca roda o comando.
beforeEach(async () => {
  mock = installDockerSpawnMock();
  mod = await isolatedRunCommand(`tools-${seq++}`);
  mod.configureRunCommand({ sandbox: true });
});
afterEach(() => mock.restore());

test("caminho fora do cwd é recusado; dentro é aceito", () => {
  const cwd = dir();
  expect(resolveWithin(cwd, "ok.txt")).toBe(join(cwd, "ok.txt"));
  expect(() => resolveWithin(cwd, "../escape.txt")).toThrow(/fora/);
  expect(() => resolveWithin(cwd, resolve(cwd, "..", "outside.txt"))).toThrow(/fora/);
});

test("write+read roundtrip no cwd", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  const w = await ex.run(ctx(cwd), { id: "1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "olá" }) });
  expect(w.isError).toBeFalsy();
  const r = await ex.run(ctx(cwd), { id: "2", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) });
  expect(r.output).toBe("linhas 1-1 de 1\nolá");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("olá");
});

test("tool desconhecida, args ilegíveis e fora do allow → erro, não crash", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  expect((await ex.run(ctx(cwd), { id: "1", name: "ghost", arguments: "{}" })).isError).toBe(true);
  expect((await ex.run(ctx(cwd), { id: "2", name: "read_file", arguments: "{quebrado" })).isError).toBe(true);
  const denied = new ToolExecutor({ approveTool: () => true, tools: [readFileTool], allow: [], audit: new Auditor(join(cwd, ".astro", "audit2.jsonl")) });
  expect((await denied.run(ctx(cwd), { id: "3", name: "read_file", arguments: '{"path":"a.txt"}' })).isError).toBe(true);
});

test("timeout devolve erro", async () => {
  const cwd = dir();
  const slow: Tool = {
    manifest: { name: "slow", description: "x", parameters: {}, risk: "low", permission: "read", timeoutMs: 30, retryable: false, idempotent: true, sideEffects: "none", class: "read_common" },
    execute: () => new Promise<ToolResult>(() => {}),
  };
  const ex = new ToolExecutor({ approveTool: () => true, tools: [slow], allow: ["slow"], audit: new Auditor(join(cwd, ".astro", "audit.jsonl")) });
  const r = await ex.run(ctx(cwd), { id: "1", name: "slow", arguments: "{}" });
  expect(r.isError).toBe(true);
  expect(r.output.toLowerCase()).toContain("timeout");
});

test("run_command captura a saída", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  const r = await ex.run(ctx(cwd), { id: "1", name: "run_command", arguments: JSON.stringify({ command: "bun --version" }) });
  expect(r.isError).toBeFalsy();
  expect(r.output.length).toBeGreaterThan(0);
});

// Segredo sintético construído em runtime (gate G6: sem literal de segredo no diff).
const RUN_SECRET = ["s", "k", "-"].join("") + "slice3a-run-synthetic-9f8e7d6c5b";

test("run_command redige stdout antes de truncar (ADR-0027, I-03)", async () => {
  const cwd = dir();
  writeFileSync(
    join(cwd, "p.js"),
    `console.log("token=" + ${JSON.stringify(RUN_SECRET)});\n` +
      `console.log("y".repeat(20_000));\n` +
      `console.log(${JSON.stringify(RUN_SECRET)});\n`,
  );
  const r = await mod.runCommandTool.execute({ command: "bun p.js" }, ctx(cwd));
  expect(r.isError).toBeFalsy();
  // O segredo cru não pode aparecer em lugar nenhum da saída truncada…
  expect(r.output).not.toContain(RUN_SECRET);
  // …e o que cabe nos primeiros 10k chars sai mascarado, não verbatim.
  expect(r.output).toContain("[REDACTED]");
  expect(r.output.length).toBeLessThanOrEqual(10_000);
});

test("emite tool.call e tool.result na auditoria", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  await ex.run(ctx(cwd), { id: "1", name: "write_file", arguments: JSON.stringify({ path: "b.txt", content: "x" }) });
  const lines = readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.tipo)).toEqual(["tool.call", "permission.decision", "tool.result"]);
});
