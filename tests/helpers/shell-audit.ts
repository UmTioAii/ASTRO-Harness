/** Shared harness for the shell decision audit (#599): a host command behind the real gate. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../../src/audit";
import { ToolExecutor } from "../../src/tools/executor";
import type { ShellExternalDirectory, ShellRule } from "../../src/tools/shell-policy";
import type { ToolContext } from "../../src/tools/types";
import type { RunCommandModule } from "./docker-mock";

/** Payloads of `host_shell.decision`, in write order; a missing file reads as empty. */
export function listShellDecisions(auditPath: string): Record<string, unknown>[] {
  try {
    return readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { tipo: string; payload: Record<string, unknown> })
      .filter((event) => event.tipo === "host_shell.decision")
      .map((event) => event.payload);
  } catch {
    return [];
  }
}

export interface ShellHarnessOptions {
  rules?: readonly ShellRule[];
  externalDirectory?: ShellExternalDirectory;
  mode?: "ask" | "bypass";
  approve?: () => unknown;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

/** Configures the isolated module for the host and runs commands through a real `ToolExecutor`. */
export async function shellHarness(mod: RunCommandModule, opts: ShellHarnessOptions = {}) {
  mod.configureRunCommand({
    mode: "host",
    ...(opts.rules === undefined ? {} : { rules: opts.rules }),
    ...(opts.externalDirectory === undefined ? {} : { externalDirectory: opts.externalDirectory }),
    ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
  });
  const cwd = mkdtempSync(join(tmpdir(), "astro-shell-audit-"));
  const auditPath = join(cwd, ".astro", "audit.jsonl");
  const requests: unknown[] = [];
  const executor = new ToolExecutor({
    tools: [mod.runCommandTool],
    allow: ["run_command"],
    audit: new Auditor(auditPath),
    permissionMode: opts.mode ?? "ask",
    approveTool: (request) => {
      requests.push(request);
      return (opts.approve?.() ?? false) as boolean;
    },
  });
  const ctx: ToolContext = { cwd, run: "r1", agent: "coder", env: opts.env ?? { ...process.env } };
  return {
    cwd, auditPath, requests, executor,
    run: (command: string) => executor.run(ctx, {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command }),
    }),
  };
}
