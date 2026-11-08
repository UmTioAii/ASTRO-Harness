import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnResult } from "../src/chat/agent-session";
import { runRepl, type ChatSession, type ReplIO } from "../src/chat/repl";
import type { AttachmentMeta } from "../src/attachments/model";

class ScriptedIO implements ReplIO {
  readonly outputs: string[] = [];
  readonly prompts: string[] = [];
  constructor(private readonly lines: Array<string | null>) {}
  async read(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    return this.lines.shift() ?? null;
  }
  write(text: string): void {
    this.outputs.push(text);
  }
}

class CaptureSession implements ChatSession {
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
  snapshot() {
    return {
      id: "s1", startedAt: "2026-11-08T12:00:00.000Z", model: this.model,
      messages: [], turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
    };
  }
  close(): void {}
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-att-repl-"));
  dirs.push(dir);
  return dir;
}

describe("/attach e /paste no REPL (ADR-0026, #392)", () => {
  test("anexa arquivo, materializa no prompt e envia metadados", async () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "a.txt"), "um\ndois\n");
    const session = new CaptureSession();
    await runRepl(session, new ScriptedIO(["/attach a.txt", "resuma", "/exit"]), { cwd });
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.prompt).toBe("resuma\n\n[anexo: a.txt]\num\ndois\n");
    expect(session.sent[0]?.attachments?.[0]).toMatchObject({ kind: "text", name: "a.txt", mediaType: "text/plain" });
  });

  test("/attach sem path lista pendentes e /detach all limpa", async () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "a.txt"), "x");
    const io = new ScriptedIO(["/attach a.txt", "/attach", "/detach all", "/attach", "/exit"]);
    await runRepl(new CaptureSession(), io, { cwd });
    const text = io.outputs.join("\n");
    expect(text).toContain("1. a.txt");
    expect(text).toContain("anexos removidos");
    expect(text.match(/nenhum anexo pendente/g)?.length).toBe(1);
  });

  test("hard-block mostra erro e não envia o prompt", async () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, ".env"), "KEY=1");
    const session = new CaptureSession();
    const io = new ScriptedIO(["/attach .env", "oi", "/exit"]);
    await runRepl(session, io, { cwd });
    expect(session.sent[0]?.prompt).toBe("oi");
    expect(io.outputs.join("\n")).toContain("bloqueado");
  });

  test("/paste usa o leitor injetado e limpa após o turno", async () => {
    const cwd = sandbox();
    const session = new CaptureSession();
    const io = new ScriptedIO(["/paste", "leia", "outra", "/exit"]);
    await runRepl(session, io, { cwd, clipboard: () => "colado" });
    expect(session.sent[0]?.prompt).toBe("leia\n\n[anexo: clipboard]\ncolado");
    expect(session.sent[1]?.prompt).toBe("outra");
    expect(session.sent[1]?.attachments).toBeUndefined();
  });
});
