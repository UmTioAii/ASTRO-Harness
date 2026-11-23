import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPError } from "../src/mcp/types";
import type { MCPServerConfig } from "../src/core/config";
import { MCPRegistry } from "../src/mcp/registry";
import { waitFor } from "./helpers/wait";

const STUB = `
import { appendFileSync, existsSync } from "node:fs";
if (process.env.ATTEMPT_FILE !== undefined) appendFileSync(process.env.ATTEMPT_FILE, "1\\n");
if (process.env.FAIL_FILE !== undefined && existsSync(process.env.FAIL_FILE)) process.exit(1);
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length === 0) continue;
    const msg = JSON.parse(line);
    const reply = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
    if (msg.method === "initialize") {
      if (process.env.PID_FILE !== undefined) appendFileSync(process.env.PID_FILE, process.pid + "\\n");
      // Parks the handshake until the gate file appears / while the hold file exists, so a test that
      // closes mid-connect never races a fixed delay (#628). Bounded: a test that dies before
      // releasing it must not leave a child spinning on Atomics.wait forever (#628).
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        if (process.env.INIT_GATE !== undefined && !existsSync(process.env.INIT_GATE)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
        if (process.env.INIT_HOLD !== undefined && existsSync(process.env.INIT_HOLD)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
        break;
      }
      if (Date.now() >= until) process.exit(0); // nobody released it: leave no CPU-burning orphan
      if (process.env.INIT_DELAY !== undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.INIT_DELAY));
      reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stdio-registry", version: "1" } } });
    } else if (msg.method === "tools/list") reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo" }, { name: "boom" }, { name: "suicide" }] } });
    else if (msg.params?.name === "boom") reply({ jsonrpc: "2.0", id: msg.id, error: { message: "boom ferramenta" } });
    else if (msg.params?.name === "suicide") process.exit(1);
    else reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "stdio-ok" }] } });
  }
});
`;

function writeStub(dir: string): string {
  const script = join(dir, "server.js");
  writeFileSync(script, STUB.trim());
  return script;
}
const pidFileOf = (dir: string) => join(dir, "pids");
const pids = (file: string): number[] =>
  (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []).map(Number);
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
/** Espera o SO confirmar a morte (não um sleep fixo) e devolve um turno do loop para o `exit` do filho chegar ao transport. */
const waitDead = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!alive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};
/**
 * Morte confirmada + entrega do `exit` ao transport. A chamada seguinte precisa ver o cliente
 * fechado: sem essa entrega o write cai em EPIPE e o erro não é /indisponível/ (#540).
 */
const waitObservedDeath = async (pid: number, closed: () => boolean): Promise<boolean> => {
  if (!(await waitDead(pid))) return false;
  // Sinal real: o transport já processou o exit do filho (senão o write seguinte cai em EPIPE).
  await waitFor(closed, "transporte observou a morte do filho");
  return true;
};
// `process.execPath` é o próprio binário bun: não passa pelo shim `.cmd` do PATH (um processo menos
// por spawn). 15000ms cobre spawn real + handshake; 3000ms estourava sob a carga da suíte (#540).
const stdioCfg = (pidFile: string, opts: { delay?: number; gate?: string; hold?: string } = {}): MCPServerConfig => ({
  transport: "stdio", command: process.execPath, args: [writeStub(join(pidFile, ".."))], timeoutMs: 15_000, enabled: true,
  env: {
    PID_FILE: pidFile,
    ...(opts.delay === undefined ? {} : { INIT_DELAY: String(opts.delay) }),
    ...(opts.gate === undefined ? {} : { INIT_GATE: opts.gate }),
    ...(opts.hold === undefined ? {} : { INIT_HOLD: opts.hold }),
  },
});

test("registry conecta com isolamento, namespace e cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const script = writeStub(dir);
  const pidFile = pidFileOf(dir);
  const warnings: string[] = [];
  const registry = new MCPRegistry({
    servers: {
      fs: { transport: "stdio", command: process.execPath, args: [script], timeoutMs: 15_000, enabled: true, env: { PID_FILE: pidFile } },
      morto: { transport: "stdio", command: process.execPath, args: [join(dir, "nao-existe.js")], timeoutMs: 15_000, enabled: true },
      off: { transport: "stdio", command: process.execPath, args: [script], timeoutMs: 15_000, enabled: false },
    },
    warn: (message) => warnings.push(message),
  });

  const report = await registry.connectAll();
  expect(report.connected.map((info) => info.server)).toEqual(["fs"]);
  expect(report.failed.map((info) => info.server)).toEqual(["morto"]);
  expect(warnings.join("\n")).toMatch(/morto/);

  expect(registry.listTools()).toEqual([
    { server: "fs", tool: { name: "echo" } }, { server: "fs", tool: { name: "boom" } }, { server: "fs", tool: { name: "suicide" } },
  ]);
  expect(pids(pidFile)).toHaveLength(1);

  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");
  await expect(registry.call("morto", "echo", {})).rejects.toThrow(/morto/);
  await expect(registry.call("off", "echo", {})).rejects.toThrow(/desabilitado/);
  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok"); // fs segue vivo

  registry.close();
}, 20_000); // 2 spawns reais (fs + morto) no win32

test("erro de tool não reconecta nem reexecuta; morte do servidor reconecta uma vez", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const pidFile = pidFileOf(dir);
  const registry = new MCPRegistry({ servers: { fs: stdioCfg(pidFile) }, warn: () => {} });

  await registry.connectAll();
  expect(pids(pidFile)).toHaveLength(1);

  // erro de tool (JSON-RPC error): propaga sem reconexão; assert via .then (expect.rejects afoga stdout no bun/win)
  const caught = await registry.call("fs", "boom", {}).then(() => "resolvido", (error: Error) => error.message);
  expect(caught).toMatch(/boom ferramenta/);
  expect(pids(pidFile)).toHaveLength(1);
  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");

  // morte do processo na chamada: reconecta uma vez e segue
  await expect(registry.call("fs", "suicide", {})).rejects.toThrow(/encerrou|indisponível/);
  expect(pids(pidFile)).toHaveLength(2);
  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");

  // registro fechado não ressuscita servidor
  registry.close();
  await expect(registry.call("fs", "echo", {})).rejects.toThrow(/fechado/);
}, 20_000); // 2 spawns reais no win32

test("chamadas concorrentes em cliente morto: MCPError e uma reconexão", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const pidFile = pidFileOf(dir);
  const registry = new MCPRegistry({ servers: { fs: stdioCfg(pidFile) }, warn: () => {} });
  await registry.connectAll();
  const dead = pids(pidFile)[0];
  expect(dead).toBeDefined();
  process.kill(dead!); // morte fora do registry
  await expect(waitObservedDeath(dead!, () => registry.isClosed("fs"))).resolves.toBe(true); // morte real + entrega do exit

  const results = await Promise.allSettled([
    registry.call("fs", "echo", {}),
    registry.call("fs", "echo", {}),
    registry.call("fs", "echo", {}),
  ]);
  for (const result of results) {
    if (result.status === "fulfilled") expect(result.value.content[0]!.text).toBe("stdio-ok");
    else expect(result.reason instanceof MCPError).toBe(true); // nada de TypeError cru
  }
  expect(pids(pidFile)).toHaveLength(2); // exatamente uma reconexão
  registry.close();
}, 20_000);

test("close durante reconexão não deixa órfão e classifica o erro", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const pidFile = pidFileOf(dir);
  const hold = join(dir, "init-hold");
  const registry = new MCPRegistry({ servers: { fs: stdioCfg(pidFile, { hold }) }, warn: () => {} });
  await registry.connectAll();
  const dead = pids(pidFile)[0];
  expect(dead).toBeDefined();
  process.kill(dead!);
  await expect(waitObservedDeath(dead!, () => registry.isClosed("fs"))).resolves.toBe(true);

  writeFileSync(hold, "1"); // o próximo initialize fica parado até o arquivo sair
  const inFlight = registry.call("fs", "echo", {});
  try {
    await waitFor(() => pids(pidFile).length === 2, "reconexão spawnou (initialize parado no hold)");
    registry.close();
    // The reconnect can only finish after close(), so no fixed window decides the outcome (#628).
    rmSync(hold);
    await expect(inFlight).rejects.toThrow(/fechado/);
    await expect(waitDead(pids(pidFile)[1]!)).resolves.toBe(true); // cliente pós-close é fechado
  } finally {
    // A failed wait above must not leave the reconnect parked: close first, then release the hold (#628).
    registry.close();
    rmSync(hold, { force: true });
    await inFlight.catch(() => {});
  }
}, 20_000);

test("close durante connectAll não deixa órfãos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const pidFile = pidFileOf(dir);
  const slowPidFile = join(dir, "pids-lento");
  const gate = join(dir, "init-gate");
  const registry = new MCPRegistry({ servers: { fs: stdioCfg(pidFile), lento: stdioCfg(slowPidFile, { gate }) }, warn: () => {} });
  const inFlight = registry.connectAll();
  try {
    await waitFor(() => pids(pidFile).length === 1, "fs connected");
    expect(pids(pidFile)).toHaveLength(1); // the already-connected server exists before close
    await waitFor(() => pids(slowPidFile).length === 1, "the slow server is parked in initialize");
    // close lands while the handshake is still parked (never inside a fixed window) and the handshake
    // only finishes after it, so the assertion below cannot depend on runner speed (#628).
    registry.close();
    writeFileSync(gate, "go");
    await expect(inFlight).rejects.toThrow(/fechado/);
    await expect(waitDead(pids(slowPidFile)[0]!)).resolves.toBe(true);
    await expect(waitDead(pids(pidFile)[0]!)).resolves.toBe(true); // o servidor que já tinha conectado também morre
  } finally {
    // A failed wait above must not leak the parked child: close first, then release the handshake (#628).
    registry.close();
    writeFileSync(gate, "go");
    await inFlight.catch(() => {});
  }
}, 20_000);

test("reconexão com backoff exponencial: falha rápido no cooldown, dobra e reseta no sucesso", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const script = writeStub(dir);
  const pidFile = pidFileOf(dir);
  const attemptFile = join(dir, "attempts");
  const failFile = join(dir, "fail");
  const clock = { now: 0 };
  const warnings: string[] = [];
  const registry = new MCPRegistry({
    servers: {
      fs: {
        transport: "stdio", command: process.execPath, args: [script], timeoutMs: 15_000, enabled: true, retryBackoffMs: 100,
        env: { PID_FILE: pidFile, ATTEMPT_FILE: attemptFile, FAIL_FILE: failFile },
      },
    },
    warn: (message) => warnings.push(message),
    now: () => clock.now,
  });
  const attempts = () => (existsSync(attemptFile) ? readFileSync(attemptFile, "utf8").split("\n").filter(Boolean).length : 0);
  const failure = (promise: Promise<unknown>) => promise.then(() => "ok", (error: Error) => error.message);

  try {
    await registry.connectAll();
    expect(attempts()).toBe(1);

    // morte + conexão quebrada: o retry imediato acontece, mas a chamada seguinte cai no cooldown
    writeFileSync(failFile, "x");
    const pid = pids(pidFile)[0]!;
    process.kill(pid);
    await expect(waitObservedDeath(pid, () => registry.isClosed("fs"))).resolves.toBe(true); // morte real + entrega do exit
    expect(await failure(registry.call("fs", "echo", {}))).toMatch(/indisponível/);
    expect(attempts()).toBe(2);

    const cooling = await failure(registry.call("fs", "echo", {}));
    expect(cooling).toMatch(/nova tentativa em 100ms/);
    expect(attempts()).toBe(2); // cooldown não spawna

    // fim do cooldown: tenta de novo, falha e dobra o próximo intervalo
    clock.now = 100;
    expect(await failure(registry.call("fs", "echo", {}))).toMatch(/indisponível/);
    expect(attempts()).toBe(3);
    expect(await failure(registry.call("fs", "echo", {}))).toMatch(/nova tentativa em 200ms/);
    expect(attempts()).toBe(3);

    // servidor volta: conecta no fim do cooldown e zera o backoff
    clock.now = 300;
    rmSync(failFile);
    expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");
    expect(attempts()).toBe(4);

    // nova queda volta à base (reset), não ao intervalo acumulado
    writeFileSync(failFile, "x");
    const alive = pids(pidFile)[1]!;
    process.kill(alive);
    await expect(waitObservedDeath(alive, () => registry.isClosed("fs"))).resolves.toBe(true);
    expect(await failure(registry.call("fs", "echo", {}))).toMatch(/indisponível/);
    expect(attempts()).toBe(5);
    expect(await failure(registry.call("fs", "echo", {}))).toMatch(/nova tentativa em 100ms/);
    expect(attempts()).toBe(5);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  } finally {
    registry.close();
  }
}, 30_000); // 5 spawns de processo bun; no win32 cada spawn leva ~1s

test("3 calls concorrentes na mesma reconexão quebrada contam 1 falha e 1 warn (#148)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const clock = { now: 0 };
  const warnings: string[] = [];
  const registry = new MCPRegistry({
    servers: {
      morto: { transport: "stdio", command: process.execPath, args: [join(dir, "nao-existe.js")], timeoutMs: 15_000, enabled: true, retryBackoffMs: 100 },
    },
    warn: (message) => warnings.push(message),
    now: () => clock.now,
  });
  const failure = (promise: Promise<unknown>) => promise.then(() => "ok", (error: Error) => error.message);
  try {
    const results = await Promise.allSettled([
      registry.call("morto", "echo", {}),
      registry.call("morto", "echo", {}),
      registry.call("morto", "echo", {}),
    ]);
    for (const result of results) expect(result.status).toBe("rejected");
    expect(warnings).toHaveLength(1); // 1 warn por tentativa compartilhada, não 3
    // próxima espera == base (100ms); com contagem por chamador seria 100 * 2^2 = 400ms
    const cooling = await failure(registry.call("morto", "echo", {}));
    expect(cooling).toMatch(/nova tentativa em 100ms/);
  } finally {
    registry.close();
  }
});

test("http com sessão expirada reconecta e recupera", async () => {
  let sessions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { method: string; id: number };
      if (body.method === "initialize") {
        sessions += 1;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sess-mock", version: "1" } } }, { headers: { "mcp-session-id": `sess-${sessions}` } });
      }
      if (req.headers.get("mcp-session-id") !== `sess-${sessions}`) return new Response(null, { status: 404 }); // sessão expirada
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo" }] } });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `ok:${sessions}` }] } });
    },
  });
  try {
    const registry = new MCPRegistry({ servers: { api: { transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeoutMs: 10_000, enabled: true } }, warn: () => {} });
    try {
      expect((await registry.connectAll()).connected).toHaveLength(1);
      expect((await registry.call("api", "echo", {})).content[0]!.text).toBe("ok:1");
      sessions += 1; // servidor expira sess-1
      expect((await registry.call("api", "echo", {})).content[0]!.text).toBe("ok:3"); // reconecta e recupera
      expect(sessions).toBe(3);
    } finally {
      registry.close();
    }
  } finally {
    server.stop(true);
  }
}, 20_000); // 3 handshakes de loopback; o teto de 2000ms do handshake estourava sob carga (#540)

