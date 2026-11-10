import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type SendTurnOptions, type TurnResult } from "../src/chat/agent-session";
import { runRepl, type ChatSession, type ReplIO } from "../src/chat/repl";
import type { AttachmentMeta, LoadedAttachment } from "../src/attachments/model";

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
  sent: Array<{ prompt: string; attachments?: readonly LoadedAttachment[] }> = [];
  async send(prompt: string, _signal?: AbortSignal, _onToken?: (text: string) => void, _attachments?: AttachmentMeta[], turn?: SendTurnOptions): Promise<TurnResult> {
    this.sent.push({ prompt, ...(turn?.attachments === undefined ? {} : { attachments: [...turn.attachments] }) });
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

  test("mesmo anexo duas vezes é recusado e materializa um bloco só", async () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "a.txt"), "um\ndois\n");
    const session = new CaptureSession();
    const io = new ScriptedIO(["/attach a.txt", "/attach a.txt", "resuma", "/exit"]);
    await runRepl(session, io, { cwd });
    expect(io.outputs.join("\n")).toContain("já adicionado: a.txt");
    expect(session.sent[0]?.prompt).toBe("resuma\n\n[anexo: a.txt]\num\ndois\n");
    expect(session.sent[0]?.attachments).toHaveLength(1);
  });
});

/** PNG 1x1 real (70 bytes), o mesmo fixture do teste de turno. */
const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
interface CapturedBody { messages?: Array<{ role?: string; content?: unknown }> }

/** Sessão real + servidor local que captura o corpo: exercita o wire até o provider. */
function e2eSetup() {
  const base = sandbox();
  const cwd = join(base, "work"), home = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cwd, "a.png"), Buffer.from(pngData, "base64"));
  const bodies: CapturedBody[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    bodies.push((await req.json()) as CapturedBody);
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192, capabilities: { vision: true } }],
    agent: { model: "p/m1", maxSteps: 1, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const session = new AgentSession({ configPath, cwd, env: { ASTRO_HOME: home, ASTRO_ALLOW_PRIVATE_URLS: "1", KEY: "k" } });
  return { cwd, home, bodies, session, stop: () => server.stop(true) };
}

describe("imagem no turno do REPL (ADR-0026, #392)", () => {
  test("imagem aprovada chega ao provider como image_url", async () => {
    const { cwd, bodies, session, stop } = e2eSetup();
    try {
      await runRepl(session, new ScriptedIO(["/attach a.png", "resuma", "s", "/exit"]), { cwd, interactive: true });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.messages?.at(-1)?.content).toContainEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${pngData}` } });
    } finally {
      stop();
    }
  });

  test("resposta 'sair' não aprova por prefixo e nega o turno", async () => {
    const { cwd, home, bodies, session, stop } = e2eSetup();
    const io = new ScriptedIO(["/attach a.png", "resuma", "sair", "/exit"]);
    try {
      await runRepl(session, io, { cwd, interactive: true });
      expect(bodies).toHaveLength(0);
      expect(io.outputs.join("\n")).toContain("não aprovado");
      expect(readdirSync(join(home, "attachments"))).toHaveLength(0);
      const auditPath = join(cwd, ".astro", "audit.jsonl");
      expect(existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "").not.toContain("attachment.approved");
    } finally {
      stop();
    }
  });

  test("sem TTY imagem é negada sem perguntar", async () => {
    const { cwd, home, bodies, session, stop } = e2eSetup();
    const io = new ScriptedIO(["/attach a.png", "resuma", "/exit"]);
    try {
      await runRepl(session, io, { cwd });
      expect(bodies).toHaveLength(0);
      expect(io.outputs.join("\n")).toContain("não aprovado");
      expect(io.prompts.join("\n")).not.toContain("aprovar envio?");
      expect(readdirSync(join(home, "attachments"))).toHaveLength(0);
    } finally {
      stop();
    }
  });
});
