import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot, TurnResult } from "../src/chat/agent-session";
import type { ChatSession } from "../src/chat/repl";
import type { AttachmentMeta } from "../src/attachments/model";
import { TuiApp } from "../src/tui/app";

class FakeSession implements ChatSession {
  model = "p/m1";
  sent: Array<{ prompt: string; attachments?: AttachmentMeta[] }> = [];
  async send(prompt: string, _signal?: AbortSignal, _onToken?: (text: string) => void, attachments?: AttachmentMeta[]): Promise<TurnResult> {
    this.sent.push({ prompt, ...(attachments === undefined ? {} : { attachments }) });
    return {
      final: "ok", model: this.model, steps: 1, tokensIn: 1, tokensOut: 1, costUsd: 0,
      totalTokensIn: 1, totalTokensOut: 1, totalCostUsd: 0,
      contextTokens: 1, contextLimit: 100, contextRatio: 0.01, warning: false, trimmed: false,
    };
  }
  compact(): Promise<string> {
    return Promise.resolve("noop");
  }
  clear(): void {}
  resume(): void {}
  setModel(ref: string): string {
    return ref;
  }
  listModels(): string[] {
    return ["p/m1"];
  }
  listProviders() {
    return [];
  }
  setProvider(): string {
    return this.model;
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-11-08T12:00:00.000Z", model: this.model,
      messages: [], turns: this.sent.length, tokensIn: 0, tokensOut: 0, costUsd: 0,
    };
  }
  close(): void {}
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

test("/attach na TUI materializa o texto e envia metadados (#392)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-att-tui-"));
  writeFileSync(join(cwd, "a.txt"), "um\ndois\n");
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("/attach a.txt");
    instance.stdin.write("\r");
    await waitFor(() => (instance.lastFrame() ?? "").includes("anexo adicionado"));
    instance.stdin.write("resuma");
    instance.stdin.write("\r");
    await waitFor(() => session.sent.length === 1);
    expect(session.sent[0]?.prompt).toContain("[anexo: a.txt]");
    expect(session.sent[0]?.attachments?.[0]).toMatchObject({ kind: "text", name: "a.txt" });
  } finally {
    instance.unmount();
  }
});
