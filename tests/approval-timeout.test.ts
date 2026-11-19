import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { createApprovalBridge } from "../src/tui/approvals";
import { ConfigError, validateConfig } from "../src/core/config";
import type { PermissionApproval, PermissionMode } from "../src/permissions";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool } from "../src/tools/types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Espera até `ms`; usado para provar que um `await` que não volta não é esperado. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | "ainda-pendente"> {
  return Promise.race([promise, sleep(ms).then(() => "ainda-pendente" as const)]);
}

const call = { id: "c1", name: "write_probe", arguments: "{}" };

function probeTool(onRun: () => void): Tool {
  return {
    manifest: {
      name: "write_probe",
      description: "teste",
      parameters: { type: "object", properties: {} },
      risk: "low",
      permission: "write",
      class: "edit",
      timeoutMs: 5_000,
      retryable: false,
      idempotent: false,
      sideEffects: "filesystem",
    },
    async execute() {
      onRun();
      return { output: "ok" };
    },
  };
}

/** Aprovador que só responde no fim da janela: simula humano que não respondeu. */
function lateApprover(delayMs: number, answer: PermissionApproval = true): () => Promise<PermissionApproval> {
  return async () => {
    await sleep(delayMs);
    return answer;
  };
}

function setup(
  approve: () => PermissionApproval | Promise<PermissionApproval>,
  approvalTimeoutMs: number,
): { cwd: string; audit: Auditor; executor: ToolExecutor; ran: () => boolean } {
  const cwd = mkdtempSync(join(tmpdir(), "astro-approval-timeout-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  let ran = false;
  const executor = new ToolExecutor({
    tools: [probeTool(() => {
      ran = true;
    })],
    allow: ["write_probe"],
    audit,
    permissionMode: "ask" as PermissionMode,
    approveTool: approve,
    approvalTimeoutMs,
  });
  return { cwd, audit, executor, ran: () => ran };
}

describe("espera de aprovação tem limite e é cancelável (#526)", () => {
  test("o gate marca a espera como expirada e informa o limite ao aprovador", async () => {
    let captured: { timedOut?: boolean; timeoutMs?: number } | undefined;
    const slow = async (
      _request: unknown,
      wait?: { timedOut?: boolean; timeoutMs?: number },
    ): Promise<PermissionApproval> => {
      captured = wait;
      await sleep(200);
      return true;
    };
    const { cwd, executor } = setup(slow as never, 20);
    const result = await executor.run({ cwd, run: "r-wait", agent: "a" }, call);
    expect(result.isError).toBe(true);
    // O aprovador recebe o mesmo objeto: depois do abort ele já vê motivo e limite.
    expect(captured?.timedOut).toBe(true);
    expect(captured?.timeoutMs).toBe(20);
  });
  test("expira a espera e recusa a tool sem esperar o aprovador", async () => {
    const { cwd, audit, executor, ran } = setup(lateApprover(1_500), 20);

    const result = await settledWithin(
      executor.run({ cwd, run: "r1", agent: "a" }, call),
      5_000,
    );

    expect(result).not.toBe("ainda-pendente");
    if (result === "ainda-pendente") return;
    expect(ran()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("aprovação expirada");
    const timedOut = audit.readAll().filter((entry) => entry.tipo === "permission.timed_out");
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]!.payload).toMatchObject({
      name: "write_probe",
      action: "edit",
      mode: "ask",
      timeoutMs: 20,
    });
    // A expiração também é um deny no fluxo canônico (D-24), não só um evento próprio.
    const decisions = audit.readAll().filter((entry) => entry.tipo === "permission.decision");
    expect(decisions.at(-1)!.payload).toMatchObject({ decision: "deny", action: "edit", mode: "ask" });
  });

  test("aprovador que responde antes do teto não vira deny", async () => {
    const { cwd, executor, ran } = setup(lateApprover(5), 1_000);

    const result = await executor.run({ cwd, run: "r1", agent: "a" }, call);

    expect(result.isError).toBeFalsy();
    expect(ran()).toBe(true);
  });

  test("sem approvalTimeoutMs o executor usa o default de 300000", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-approval-default-"));
    const executor = new ToolExecutor({
      tools: [probeTool(() => {})],
      allow: ["write_probe"],
      audit: new Auditor(join(cwd, "audit.jsonl")),
      permissionMode: "ask" as PermissionMode,
      approveTool: () => true,
    });

    expect(executor.approvalTimeoutMs).toBe(300_000);
  });

  test("cancelar o run interrompe a aprovação pendente na hora", async () => {
    // Aprovador só responderia em 10 s: o abort tem de vencer bem antes disso.
    const { cwd, audit, executor } = setup(lateApprover(10_000), 60_000);
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 20);

    const result = await settledWithin(
      executor.run({ cwd, run: "r1", agent: "a", signal: controller.signal }, call),
      15_000,
    );

    expect(result).not.toBe("ainda-pendente");
    if (result === "ainda-pendente") return;
    expect(result.isError).toBe(true);
    expect(result.output).toBe('cancelado: a tool "write_probe" foi interrompida');
    // Bem abaixo dos 10 s do aprovador e do guard: abort venceu, não esperou.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(audit.readAll().filter((entry) => entry.tipo === "permission.timed_out")).toHaveLength(0);
  });

  test("approvalTimeoutMs 0 desliga o limite e a aprovação lenta vale", async () => {
    const { cwd, executor, ran } = setup(lateApprover(30), 0);

    const result = await settledWithin(
      executor.run({ cwd, run: "r1", agent: "a" }, call),
      5_000,
    );

    expect(result).not.toBe("ainda-pendente");
    if (result === "ainda-pendente") return;
    expect(result.isError).toBeFalsy();
    expect(ran()).toBe(true);
  });

  test("a ponte de aprovação descarta a pergunta pendente quando o sinal aborta", async () => {
    const bridge = createApprovalBridge();
    const seen: unknown[] = [];
    bridge.subscribe((question) => seen.push(question));
    const controller = new AbortController();

    const pending = bridge.approveTool(
      { name: "write_probe", action: "edit", mode: "ask" },
      { signal: controller.signal },
    );
    expect(bridge.current()).toBeDefined();

    controller.abort();

    const outcome = await settledWithin(Promise.resolve(pending), 5_000);
    expect(outcome).toBe(false); // abortar resolve como negação
    expect(bridge.current()).toBeUndefined();
    expect(seen.at(-1)).toBeUndefined();
  });
});

describe("config de permissions.approvalTimeoutMs (#526)", () => {
  const base = {
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };

  test("aceita ausente, 0 e inteiro positivo; rejeita negativo, fração e não-número", () => {
    expect(validateConfig(structuredClone(base)).permissions).toEqual({ mode: "ask" });
    expect(validateConfig({ ...structuredClone(base), permissions: { approvalTimeoutMs: 0 } }).permissions)
      .toEqual({ mode: "ask", approvalTimeoutMs: 0 });
    expect(validateConfig({ ...structuredClone(base), permissions: { approvalTimeoutMs: 15_000 } }).permissions)
      .toEqual({ mode: "ask", approvalTimeoutMs: 15_000 });
    expect(() => validateConfig({ ...structuredClone(base), permissions: { approvalTimeoutMs: -1 } }))
      .toThrow(ConfigError);
    expect(() => validateConfig({ ...structuredClone(base), permissions: { approvalTimeoutMs: 1.5 } }))
      .toThrow(ConfigError);
    expect(() => validateConfig({ ...structuredClone(base), permissions: { approvalTimeoutMs: "300000" } }))
      .toThrow(ConfigError);
  });
});
