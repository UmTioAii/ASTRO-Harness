import { describe, expect, test } from "bun:test";
import { createApprovalBridge } from "../src/tui/approvals";
import { toolPrompt } from "../src/chat/approvers";
import type { SwapRequest } from "../src/approval";
import type { BudgetStatus } from "../src/budget";

const swap: SwapRequest = {
  run: "r1", from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m2" },
  reason: "fallback", costDeltaUsd: 1,
};
const budget = { limitUsd: 1, estimate: "US$ 2.000000" } as BudgetStatus;

describe("ponte de aprovação da TUI (T2, #63)", () => {
  test("swap publica a pergunta e aprova só com s/sim", async () => {
    const bridge = createApprovalBridge();
    const seen: Array<string | undefined> = [];
    bridge.subscribe((question) => seen.push(question?.text));
    const decision = bridge.approveSwap(swap);
    expect(seen.at(-1)).toContain("aprovar? [s/N]");
    expect(bridge.current()?.text).toContain("a/m1 -> b/m2");
    bridge.answer("s");
    expect(await decision).toBe(true);
    expect(bridge.current()).toBeUndefined();
    expect(seen.at(-1)).toBeUndefined();
  });

  test("resposta vazia nega; budget mapeia tokens exatos", async () => {
    const bridge = createApprovalBridge();
    const denied = bridge.approveSwap(swap);
    bridge.answer("");
    expect(await denied).toBe(false);

    const chose = createApprovalBridge();
    const lower = chose.onBudgetExceeded(budget);
    chose.answer("l");
    expect(await lower).toBe("lower_effort");

    const stopping = createApprovalBridge();
    const stop = stopping.onBudgetExceeded(budget);
    stopping.answer("p");
    expect(await stop).toBe("stop");

    const odd = createApprovalBridge();
    const cancelled = odd.onBudgetExceeded(budget);
    odd.answer("cancelar");
    expect(await cancelled).toBe("stop");
  });

  test("approveTool publica a pergunta na TUI e mapeia as 3 opções (#265)", async () => {
    const req = { name: "write_file", action: "edit" as const, mode: "ask" as const };
    const bridge = createApprovalBridge();
    const seen: Array<string | undefined> = [];
    bridge.subscribe((question) => seen.push(question?.text));
    const decision = bridge.approveTool(req);
    expect(seen.at(-1)).toContain("write_file");
    expect(seen.at(-1)).toMatch(/\[s\].*\[a\].*\[r\]/);
    expect(seen.at(-1)).not.toContain("[o]");
    expect(bridge.current()?.text).toBe(seen.at(-1));
    bridge.answer("S");
    expect(await decision).toBe("always");
    expect(bridge.current()).toBeUndefined();

    const odd = createApprovalBridge();
    const dOdd = odd.approveTool(req);
    odd.answer("o");
    expect(await dOdd).toBe(false);

    const yes = createApprovalBridge();
    const dYes = yes.approveTool(req);
    yes.answer("s");
    expect(await dYes).toBe("once");

    const no = createApprovalBridge();
    const dNo = no.approveTool(req);
    no.answer("n");
    expect(await dNo).toBe(false);

    for (const answer of ["y", "yes", "sim", "", "x"]) {
      const outside = createApprovalBridge();
      const decisionOutside = outside.approveTool(req);
      outside.answer(answer);
      expect(await decisionOutside).toBe(false);
    }
  });

  test("approveTool com diff publica a pergunta com o anexo para o overlay (#64 D2)", async () => {
    const bridge = createApprovalBridge();
    const diff = { path: "a.ts", content: "@@ -1 +1 @@\n-x\n+y\n" };
    const decision = bridge.approveTool({ name: "edit", action: "edit", mode: "ask", diff });
    expect(bridge.current()?.text).toContain("edit");
    expect(bridge.current()?.diff).toEqual(diff);
    bridge.answer("s");
    expect(await decision).toBe("once");
    expect(bridge.current()).toBeUndefined();
  });

  test("approveTool publica o mesmo texto do REPL, com o argumento material (#536)", async () => {
    const req = {
      name: "run_command", action: "shell" as const, mode: "ask" as const,
      detail: { kind: "command" as const, value: "npm test" },
    };
    const bridge = createApprovalBridge();
    const decision = bridge.approveTool(req);
    expect(bridge.current()?.text).toBe(toolPrompt(req));
    expect(bridge.current()?.text).toContain("npm test");
    bridge.answer("s");
    expect(await decision).toBe("once");

    const pathReq = {
      name: "move_path", action: "delete" as const, mode: "ask" as const,
      detail: { kind: "path" as const, value: "a.ts -> dir/b.ts" },
    };
    const moving = createApprovalBridge();
    const moveDecision = moving.approveTool(pathReq);
    expect(moving.current()?.text).toBe(toolPrompt(pathReq));
    expect(moving.current()?.text).toContain("a.ts -> dir/b.ts");
    moving.answer("n");
    expect(await moveDecision).toBe(false); // 'n' continua negando
  });

  test("cada aprovação carrega o hint das opções no composer (#635)", async () => {
    const bridge = createApprovalBridge();
    const tool = bridge.approveTool({ name: "run_command", action: "shell", mode: "ask" });
    expect(bridge.current()?.hint).toContain("s once");
    bridge.answer("n");
    expect(await tool).toBe(false);

    const swapDecision = bridge.approveSwap(swap);
    expect(bridge.current()?.hint).toBe("s aprova · n nega");
    bridge.answer("n");
    expect(await swapDecision).toBe(false);

    // askText não tem opções fixas: o composer usa o hint neutro
    void bridge.askText("confiar nesta pasta? (s/n)");
    expect(bridge.current()?.hint).toBeUndefined();
    bridge.answer("n");
  });

  test("askText publica a pergunta crua na TUI e resolve com a resposta (#267)", async () => {
    const bridge = createApprovalBridge();
    const seen: Array<string | undefined> = [];
    bridge.subscribe((question) => seen.push(question?.text));
    const answer = bridge.askText("confiar em /tmp/proj? [s/N] ");
    expect(seen.at(-1)).toContain("/tmp/proj");
    bridge.answer("s");
    expect(await answer).toBe("s");
    expect(bridge.current()).toBeUndefined();
  });
});
