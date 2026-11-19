import { describe, expect, test } from "bun:test";
import { chatApprovers, toolPrompt } from "../src/chat/approvers";
import type { SwapRequest } from "../src/approval";
import type { BudgetStatus } from "../src/budget";
import type { ReplIO } from "../src/chat/repl";

function io(answers: Array<string | null>): ReplIO {
  return { read: async () => answers.shift() ?? null, write: () => {} };
}

function ioWithFresh(queued: string[], fresh: Array<string | null>) {
  const state = { read: 0, readFresh: 0, queued: [...queued] };
  const fake: ReplIO = {
    read: async () => {
      state.read++;
      return state.queued.shift() ?? null;
    },
    readFresh: async () => {
      state.readFresh++;
      return fresh.shift() ?? null;
    },
    write: () => {},
  };
  return { io: fake, state };
}

const swap: SwapRequest = {
  run: "r1", from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m2" },
  reason: "fallback", costDeltaUsd: 1,
};
const budget = { limitUsd: 1, estimate: "US$ 2.000000" } as BudgetStatus;

describe("decisores interativos do chat", () => {
  test("swap: s/yes aprova; n/EOF nega", async () => {
    const yes = chatApprovers(io(["s"]), true).approveSwap!;
    const no = chatApprovers(io(["n"]), true).approveSwap!;
    const eof = chatApprovers(io([null]), true).approveSwap!;
    expect(await yes(swap)).toBe(true);
    expect(await no(swap)).toBe(false);
    expect(await eof(swap)).toBe(false);
  });
  test("budget: c/l/p mapeiam as três escolhas; outros param", async () => {
    const decider = (answer: string) => chatApprovers(io([answer]), true).onBudgetExceeded!;
    expect(await decider("c")(budget)).toBe("continue_same");
    expect(await decider("l")(budget)).toBe("lower_effort");
    expect(await decider("p")(budget)).toBe("stop");
    expect(await decider("x")(budget)).toBe("stop");
  });
  test("sem TTY não injeta decisores", () => {
    expect(chatApprovers(io([]), false)).toEqual({});
  });
  test("budget só aceita tokens exatos; 'cancelar' e instrução param", async () => {
    const decider = (answer: string) => chatApprovers(io([answer]), true).onBudgetExceeded!;
    expect(await decider("cancelar")(budget)).toBe("stop");
    expect(await decider("corrija o bug")(budget)).toBe("stop");
    expect(await decider("")(budget)).toBe("stop");
    expect(await decider("continuar")(budget)).toBe("continue_same");
    expect(await decider("baixar")(budget)).toBe("lower_effort");
  });
  test("decisores leem linha nova e preservam a fila do REPL", async () => {
    const swapIo = ioWithFresh(["corrija o bug"], ["n"]);
    expect(await chatApprovers(swapIo.io, true).approveSwap!(swap)).toBe(false);
    expect(swapIo.state.read).toBe(0);
    expect(swapIo.state.readFresh).toBe(1);
    expect(swapIo.state.queued).toEqual(["corrija o bug"]);

    const budgetIo = ioWithFresh([], ["c"]);
    expect(await chatApprovers(budgetIo.io, true).onBudgetExceeded!(budget)).toBe("continue_same");
    expect(budgetIo.state.readFresh).toBe(1);
  });
});

describe("approveTool no REPL (PERM-04, #265)", () => {
  const req = { name: "write_file", action: "edit" as const, mode: "ask" as const };

  test("três opções: s=aprova uma vez, n/EOF=nega, S=aprova na sessão", async () => {
    expect(await chatApprovers(io(["s"]), true).approveTool!(req)).toBe(true);
    expect(await chatApprovers(io(["n"]), true).approveTool!(req)).toBe(false);
    expect(await chatApprovers(io([null]), true).approveTool!(req)).toBe(false);
    expect(await chatApprovers(io(["S"]), true).approveTool!(req)).toBe("session");
    expect(await chatApprovers(io(["sessao"]), true).approveTool!(req)).toBe(false);
    expect(await chatApprovers(io(["session"]), true).approveTool!(req)).toBe(false);
  });

  test("[o] deixou de existir: resposta desconhecida nega", async () => {
    expect(await chatApprovers(io(["o"]), true).approveTool!(req)).toBe(false);
    expect(await chatApprovers(io(["once"]), true).approveTool!(req)).toBe(false);
  });

  test("só o vocabulário do prompt aprova: y/yes/sim/vazio negam (#546)", async () => {
    for (const answer of ["y", "Y", "yes", "Yes", "sim", "SIM", "", "x", "aprovar"]) {
      expect(await chatApprovers(io([answer]), true).approveTool!(req)).toBe(false);
    }
  });

  test("prompt cita a tool, a ação e exatamente 3 opções", async () => {
    const prompts: string[] = [];
    const capturing: ReplIO = { read: async (p: string) => { prompts.push(p); return "s"; }, write: () => {} };
    expect(await chatApprovers(capturing, true).approveTool!(req)).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("write_file");
    expect(prompts[0]).toContain("edit");
    expect(prompts[0]).toMatch(/\[s\].*\[n\].*\[S\]/);
    expect(prompts[0]).not.toContain("[o]");
  });

  test("sem TTY não injeta approveTool", () => {
    expect(chatApprovers(io([]), false).approveTool).toBeUndefined();
  });

  test("expiração fecha a linha do prompt e nomeia o limite (#526)", async () => {
    const writes: string[] = [];
    const expiring: ReplIO = {
      read: async () => null,
      readCancelable: async () => null,
      write: (text: string) => { writes.push(text); },
    };
    const wait = { signal: new AbortController().signal, timeoutMs: 1234, timedOut: true };
    expect(await chatApprovers(expiring, true).approveTool!(req, wait)).toBe(false);
    const printed = writes.join("");
    expect(printed).toContain('"write_file"');
    expect(printed).toContain("expirada após 1234ms");
    expect(printed.startsWith("\n")).toBe(true);
  });

  test("cancelamento do run não se anuncia como expiração (#526)", async () => {
    const writes: string[] = [];
    const cancelling: ReplIO = {
      read: async () => null,
      readCancelable: async () => null,
      write: (text: string) => { writes.push(text); },
    };
    expect(await chatApprovers(cancelling, true).approveTool!(req, { signal: new AbortController().signal })).toBe(false);
    const printed = writes.join("");
    expect(printed).toContain("cancelada sem resposta");
    expect(printed).not.toContain("expirada");
  });
});

describe("prompt de tool com o argumento material (#536)", () => {
  test("run_command mostra o comando entre as opções", () => {
    const prompt = toolPrompt({
      name: "run_command", action: "shell", mode: "ask",
      detail: { kind: "command", value: "npm test -- --watch=false" },
    });
    expect(prompt).toContain("run_command");
    expect(prompt).toContain("comando");
    expect(prompt).toContain("npm test -- --watch=false");
    expect(prompt).toMatch(/\[s\].*\[n\].*\[S\]/);
  });

  test("write_file/delete_path mostram o caminho; move mostra from -> to", () => {
    const write = toolPrompt({
      name: "write_file", action: "edit", mode: "ask",
      detail: { kind: "path", value: "src/a.ts" },
    });
    expect(write).toContain("caminho");
    expect(write).toContain("src/a.ts");

    const move = toolPrompt({
      name: "move_path", action: "delete", mode: "ask",
      detail: { kind: "path", value: "a.ts -> dir/b.ts" },
    });
    expect(move).toContain("a.ts -> dir/b.ts");
  });

  test("sem detalhe o prompt é exatamente o antigo (fallback intacto)", () => {
    const request = { name: "write_file", action: "edit" as const, mode: "ask" as const };
    const prompt = toolPrompt(request);
    expect(prompt).toBe(
      'tool "write_file" (ação edit, modo ask). [s] aprovar, [n] negar, [S] aprovar toda chamada "write_file" nesta sessão: ',
    );
  });

  test("a opção S nomeia a tool: o grant é por ação+tool, não pelo comando mostrado (#536)", () => {
    const prompt = toolPrompt({
      name: "run_command", action: "shell", mode: "ask",
      detail: { kind: "command", value: "npm test" },
    });
    expect(prompt).toContain('[S] aprovar toda chamada "run_command" nesta sessão');
    // o comando mostrado não é o escopo do grant
    expect(prompt).not.toContain('[S] aprovar toda chamada "npm test"');
  });

  test("detalhe longo já chega truncado pelo gate, mas o prompt não quebra a linha", () => {
    const value = `${"a".repeat(200)}...`;
    const prompt = toolPrompt({
      name: "run_command", action: "shell", mode: "ask",
      detail: { kind: "command", value },
    });
    expect(prompt).toContain(value);
    expect(prompt).not.toContain("\n");
  });
});

describe("trustAsk no REPL (#267)", () => {
  test("pergunta a pasta e mapeia s/n; sem TTY não injeta", async () => {
    const prompts: string[] = [];
    const capturing: ReplIO = { read: async (p: string) => { prompts.push(p); return "s"; }, write: () => {} };
    expect(await chatApprovers(capturing, true).trustAsk!("/tmp/proj")).toBe(true);
    expect(prompts[0]).toContain("/tmp/proj");
    expect(await chatApprovers(io(["n"]), true).trustAsk!("/tmp/proj")).toBe(false);
    expect(await chatApprovers(io([null]), true).trustAsk!("/tmp/proj")).toBe(false);
    expect(chatApprovers(io([]), false).trustAsk).toBeUndefined();
  });
});
