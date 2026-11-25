import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { TuiApp } from "../src/tui/app";

const at = "2026-11-24T12:00:00.000Z";

function result(final: string) {
  return {
    final, model: "p/m1", steps: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
    totalTokensIn: 10, totalTokensOut: 5, totalCostUsd: 0.001,
    contextTokens: 10, contextLimit: 100, contextRatio: 0.1, warning: false, trimmed: false,
  };
}

function fakeSession() {
  return {
    model: "p/m1",
    async send(prompt: string) { return result(`eco:${prompt}`); },
    compact: async () => "não usado",
    clear() {},
    resume() {},
    setModel(ref: string) { this.model = ref; return ref; },
    listModels: () => ["p/m1"],
    providerName: () => "p",
    permissionMode: () => "ask" as const,
    snapshot: () => ({
      id: "s1", startedAt: at, model: "p/m1", messages: [], turns: 0,
      tokensIn: 10, tokensOut: 5, costUsd: 0.001,
    }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function at80() {
  const instance = render(<TuiApp session={fakeSession() as never} cwd="/tmp/astro" branch="main" />);
  Object.defineProperty(instance.stdout, "columns", { get: () => 80, configurable: true });
  instance.stdout.emit("resize");
  await sleep(150);
  return instance;
}

test("empty frame at 80 columns is pinned across the extraction (#595)", async () => {
  const instance = await at80();
  try {
    expect(instance.lastFrame()).toMatchSnapshot();
  } finally {
    instance.unmount();
  }
});

test("completed turn frame at 80 columns is pinned across the extraction (#595)", async () => {
  const instance = await at80();
  try {
    instance.stdin.write("oi");
    instance.stdin.write("\r");
    for (let i = 0; i < 100 && !(instance.lastFrame() ?? "").includes("eco:oi"); i++) await sleep(20);
    await sleep(100);
    expect(instance.lastFrame()).toMatchSnapshot();
  } finally {
    instance.unmount();
  }
});
