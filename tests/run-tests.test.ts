/**
 * `run_tests` (F-15, #538): o comando de teste vem da config (`run.tests.command`,
 * argv) e roda pelo MESMO sandbox do `run_command`, sem shell e sem comando do
 * modelo. Cobre not configured, sucesso, exit != 0, timeout, cap, redação e a
 * matriz de aprovação da classe `shell`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/core/app";
import { ConfigError, validateConfig } from "../src/core/config";
import {
  actionClassOf,
  permissionDecision,
  requiredPermission,
  type ToolPermissionRequest,
} from "../src/permissions";
import { ToolExecutor } from "../src/tools/executor";
import type { ToolResult } from "../src/tools/types";
import {
  installDockerSpawnMock,
  isolatedRunCommand,
  type DockerMock,
  type DockerRunReply,
  type RunCommandModule,
} from "./helpers/docker-mock";
import { testEnv } from "./setup";

/** Secret sintético (montado em runtime para não virar literal no arquivo — I-03). */
const SECRET = ["s", "k", "-"].join("") + "live-run-tests-987654";
/** Cap da saída de `run_command`, reusado por `run_tests`. */
const CAP = 10_000;

let seq = 0;
/** Mocks ativos; restaurados em LIFO (mock instalado depois captura o anterior como original). */
const activeMocks: DockerMock[] = [];

afterEach(() => {
  while (activeMocks.length > 0) activeMocks.pop()!.restore();
});

interface SetupOptions {
  config?: { command: string[]; timeoutMs?: number };
  reply?: (argv: string[]) => DockerRunReply;
  sandbox?: boolean;
}

/** Docker mock + módulo isolado de `run-command` (estado do sandbox por teste). */
async function setup(options: SetupOptions = {}): Promise<{
  mod: RunCommandModule;
  mock: DockerMock;
  audit: Auditor;
  tool: ReturnType<RunCommandModule["createRunTestsTool"]>;
  cwd: string;
}> {
  const cwd = mkdtempSync(join(tmpdir(), "astro-rt-"));
  const mock = installDockerSpawnMock(options.reply);
  activeMocks.push(mock);
  const mod = await isolatedRunCommand(`rt-${seq++}`);
  mod.configureRunCommand({ sandbox: options.sandbox ?? true });
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const tool = mod.createRunTestsTool({
    ...(options.config === undefined ? {} : { config: options.config }),
    audit,
  });
  return { mod, mock, audit, tool, cwd };
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

interface TestsResult {
  command: string[];
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  output: string;
}

/**
 * Faz o parse do resultado estruturado. Se a tool voltou com erro (sandbox
 * indisponível, recusa, entrada inválida), falha mostrando código e saída em vez
 * de um "Unexpected identifier" — foi assim que a diferença POSIX apareceu no CI.
 */
const resultOf = (result: ToolResult): TestsResult => {
  try {
    return JSON.parse(result.output) as TestsResult;
  } catch {
    throw new Error(
      `run_tests devolveu erro em vez do JSON de resultado (code: ${result.code ?? "nenhum"}): ${result.output}`,
    );
  }
};

/**
 * Roda `fn` com `process.platform` trocado (restaura sempre). Usado para exercitar
 * o ramo POSIX de `killProcessTree` (kill de grupo → fallback `proc.kill()`) no Windows.
 */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

/** Args entregues ao `docker run` depois da imagem (o que o container executa). */
const containerCmd = (argv: string[]): string[] =>
  argv.slice(argv.indexOf("oven/bun:1.4.2") + 1);

const baseConfig = {
  providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["run_tests"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const configWithRun = (run: unknown) => {
  const raw = structuredClone(baseConfig) as Record<string, unknown>;
  raw.run = run;
  return validateConfig(raw);
};

describe("config run.tests.command (F-15, #538)", () => {
  test("sem run.tests: nada é auto-detectado", () => {
    expect(validateConfig(structuredClone(baseConfig)).run?.tests).toBeUndefined();
  });

  test("argv é preservado; timeoutMs default é 120000 e explícito é aceito", () => {
    const cfg = configWithRun({ tests: { command: ["bun", "test"] } });
    expect(cfg.run?.tests).toEqual({ command: ["bun", "test"], timeoutMs: 120_000 });
    const custom = configWithRun({ tests: { command: ["bun", "test", "--run"], timeoutMs: 45_000 } });
    expect(custom.run?.tests).toEqual({ command: ["bun", "test", "--run"], timeoutMs: 45_000 });
  });

  test("timeoutMs tem teto de 1h: 3600000 aceito, acima falha no load", () => {
    expect(configWithRun({ tests: { command: ["bun", "test"], timeoutMs: 3_600_000 } }).run?.tests?.timeoutMs)
      .toBe(3_600_000);
    expect(() => configWithRun({ tests: { command: ["bun", "test"], timeoutMs: 3_600_001 } }))
      .toThrow(/run\.tests\.timeoutMs/);
    // Acima de 2^31-1 o setTimeout dispara em ~1ms e todo run falharia.
    expect(() => configWithRun({ tests: { command: ["bun", "test"], timeoutMs: 3_000_000_000 } }))
      .toThrow(ConfigError);
  });

  test("string de shell, lista vazia, chave desconhecida e timeout inválido falham no load", () => {
    expect(() => configWithRun({ tests: { command: "bun test" } })).toThrow(ConfigError);
    // Item único com espaço é a string de shell disfarçada de argv.
    expect(() => configWithRun({ tests: { command: ["bun test"] } })).toThrow(/argv/);
    expect(() => configWithRun({ tests: { command: [] } })).toThrow(ConfigError);
    expect(() => configWithRun({ tests: { command: ["bun", "test"], shell: true } })).toThrow(/run\.tests\.shell/);
    expect(() => configWithRun({ tests: { command: ["bun", "test"], timeoutMs: 0 } })).toThrow(ConfigError);
  });
});

describe("run_tests manifesto", () => {
  test("executa processo, só aceita `filter` e deixa o timeout do comando com o sandbox", async () => {
    const { tool } = await setup({ config: { command: ["bun", "test"], timeoutMs: 1_000 } });
    expect(tool.manifest.name).toBe("run_tests");
    expect(tool.manifest.class).toBe("shell");
    expect(tool.manifest.permission).toBe("execute");
    expect(tool.manifest.sideEffects).toBe("process");
    expect(tool.manifest.retryable).toBe(false);
    expect(tool.manifest.idempotent).toBe(false);
    // A tool precisa sobreviver ao timeout do comando para formatar o resultado.
    expect(tool.manifest.timeoutMs).toBeGreaterThan(1_000);
    const params = tool.manifest.parameters as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(Object.keys(params.properties)).toEqual(["filter"]);
    expect(params.additionalProperties).toBe(false);
  });

  test("timeoutMs absurdo passado direto à tool fica limitado antes do setTimeout", async () => {
    const { tool } = await setup({ config: { command: ["bun", "test"], timeoutMs: 3_000_000_000 } });
    expect(tool.manifest.timeoutMs).toBeLessThanOrEqual(3_605_000);
  });
});

describe("run_tests sem configuração", () => {
  test("erro tipado tests_not_configured cita run.tests.command e não spawna", async () => {
    const { tool, mock, cwd } = await setup({ reply: () => "não deveria rodar" });
    const result = await tool.execute({}, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.code).toBe("tests_not_configured");
    expect(result.output).toContain("run.tests.command");
    expect(mock.runCalls).toHaveLength(0);
  });
});

describe("run_tests execução no sandbox", () => {
  test("sucesso: exit 0, duração, saída e audit só com comando/exit", async () => {
    const { tool, mock, audit, cwd } = await setup({
      config: { command: ["bun", "test"] },
      reply: () => "3 pass\n0 fail\nOK",
    });
    const result = await tool.execute({}, ctx(cwd));
    expect(result.isError).toBeUndefined();
    const out = resultOf(result);
    expect(out.exitCode).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.output).toContain("3 pass");
    expect(typeof out.durationMs).toBe("number");

    const argv = mock.runCalls.at(-1)!;
    // Sem shell: o argv configurado vai direto para o container.
    expect(containerCmd(argv)).toEqual(["bun", "test"]);
    expect(argv).not.toContain("-c");

    const event = audit.readAll().find((entry) => entry.tipo === "tests.result");
    // #599: the argv can carry the model filter, so the audit keeps only its hash.
    expect(event?.payload).toMatchObject({ exitCode: 0, isError: false });
    expect(event?.payload.command).toBeUndefined();
    expect(String(event?.payload.commandHash)).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(event?.payload)).not.toContain("3 pass");
    expect(JSON.stringify(event?.payload)).not.toContain("bun test");
  });

  test("falha: exit != 0 devolve isError com exitCode e a saída", async () => {
    const { tool, mock, cwd } = await setup({
      config: { command: ["bun", "test"] },
      reply: () => ({ code: 1, stdout: "1 fail\nFALHOU no fim\n", stderr: "" }),
    });
    const result = await tool.execute({}, ctx(cwd));
    expect(result.isError).toBe(true);
    const out = resultOf(result);
    expect(out.exitCode).toBe(1);
    expect(out.output).toContain("FALHOU no fim");
    expect(mock.runCalls).toHaveLength(1);
  });

  test("filter entra como UM item de argv, nunca concatenado num shell", async () => {
    const { tool, mock, cwd } = await setup({ config: { command: ["bun", "test"] }, reply: () => "" });
    const filter = "math; rm -rf build";
    await tool.execute({ filter }, ctx(cwd));
    expect(containerCmd(mock.runCalls.at(-1)!)).toEqual(["bun", "test", filter]);
  });

  test("filter com flag, vazio ou campo desconhecido é invalid_input sem spawnar", async () => {
    const { tool, mock, cwd } = await setup({ config: { command: ["bun", "test"] }, reply: () => "" });
    for (const input of [{ filter: "--bail" }, { filter: "  " }, { filter: 7 }, { command: "rm -rf /" }]) {
      const result = await tool.execute(input, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.code).toBe("invalid_input");
    }
    expect(mock.runCalls).toHaveLength(0);
  });

  test("filter de 200 caracteres entra como item; 201 é invalid_input sem spawnar", async () => {
    const { mod, tool, mock, cwd } = await setup({ config: { command: ["bun", "test"] }, reply: () => "" });
    const limit = mod.MAX_TEST_FILTER_LENGTH;
    const accepted = "x".repeat(limit);
    await tool.execute({ filter: accepted }, ctx(cwd));
    expect(containerCmd(mock.runCalls.at(-1)!)).toEqual(["bun", "test", accepted]);
    const rejected = await tool.execute({ filter: `${accepted}y` }, ctx(cwd));
    expect(rejected.isError).toBe(true);
    expect(rejected.code).toBe("invalid_input");
    expect(mock.runCalls).toHaveLength(1);
  });

  test("filter com caractere de controle (\\n, \\0) é invalid_input sem spawnar", async () => {
    const { tool, mock, cwd } = await setup({ config: { command: ["bun", "test"] }, reply: () => "" });
    for (const filter of ["math\n", "a\u0000b", "\u0007bell"]) {
      const result = await tool.execute({ filter }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.code).toBe("invalid_input");
    }
    expect(mock.runCalls).toHaveLength(0);
  });

  test("timeout de run.tests.timeoutMs interrompe o container e volta tipado", async () => {
    const { tool, mock, cwd } = await setup({
      config: { command: ["bun", "test"], timeoutMs: 40 },
      reply: () => ({ hang: true }),
    });
    const result = await tool.execute({}, ctx(cwd));
    expect(result.isError).toBe(true);
    // O sandbox rodou de verdade: o erro não é "Docker indisponível".
    expect(mock.runCalls).toHaveLength(1);
    const out = resultOf(result);
    expect(out).toMatchObject({ timedOut: true, exitCode: null });
    // docker run morto não para o container: limpeza forçada.
    expect(mock.calls.some((cmd) => cmd[0] === "docker" && cmd[1] === "rm")).toBe(true);
  });

  test("cancellation: devolve cancelled e remove o container (tool direta)", async () => {
    const controller = new AbortController();
    const { tool, mock, cwd } = await setup({
      config: { command: ["bun", "test"] },
      // Aborta com o container já criado: o run fica pendurado até o kill.
      reply: () => {
        controller.abort();
        return { hang: true };
      },
    });
    const result = await tool.execute({}, { ...ctx(cwd), signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(mock.runCalls).toHaveLength(1);
    const out = resultOf(result);
    expect(out).toMatchObject({ cancelled: true, exitCode: null });
    expect(mock.calls.some((cmd) => cmd[0] === "docker" && cmd[1] === "rm")).toBe(true);
  });

  test("POSIX (simulado): timeout e cancelamento vencem o exit do kill", async () => {
    // No POSIX `killProcessTree` cai em `proc.kill()`; o processo real só resolve
    // `exited` no tick seguinte. Se o fake resolver antes, o exit 137 vence o
    // marcador e o run reporta failure sem `timedOut`/`cancelled` (falha do CI Linux).
    const timeoutRun = await setup({
      config: { command: ["bun", "test"], timeoutMs: 40 },
      reply: () => ({ hang: true }),
    });
    const timeoutResult = await withPlatform("linux", () => timeoutRun.tool.execute({}, ctx(timeoutRun.cwd)));
    expect(timeoutResult.isError).toBe(true);
    expect(resultOf(timeoutResult)).toMatchObject({ timedOut: true, exitCode: null });
    expect(timeoutRun.mock.calls.some((cmd) => cmd[0] === "docker" && cmd[1] === "rm")).toBe(true);
    // Restaura antes de instalar o próximo mock (o novo captura o atual como original).
    activeMocks.pop()!.restore();

    const controller = new AbortController();
    const cancelRun = await setup({
      config: { command: ["bun", "test"] },
      reply: () => {
        controller.abort();
        return { hang: true };
      },
    });
    const cancelResult = await withPlatform(
      "linux",
      () => cancelRun.tool.execute({}, { ...ctx(cancelRun.cwd), signal: controller.signal }),
    );
    expect(cancelResult.isError).toBe(true);
    expect(resultOf(cancelResult)).toMatchObject({ cancelled: true, exitCode: null });
    expect(cancelRun.mock.calls.some((cmd) => cmd[0] === "docker" && cmd[1] === "rm")).toBe(true);
  });

  test("sandbox:false recusa sem tocar o host e sem spawn", async () => {
    const { tool, mock, cwd } = await setup({ sandbox: false, config: { command: ["bun", "test"] } });
    const result = await tool.execute({}, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.code).toBe("sandbox_required_for_shell");
    expect(result.output).toContain("sandbox:false");
    expect(mock.calls).toHaveLength(0);
  });
});

/** Saída longa e variada: passa pela redação intacta (um bloco uniforme vira [REDACTED]). */
const bigOutput = (label: string): string =>
  Array.from({ length: 1_200 }, (_, index) => `${label} ${index}: pass`).join("\n");

describe("run_tests cap e redação da saída", () => {
  test("saída acima do cap trunca no mesmo limite do run_command", async () => {
    const { tool, cwd } = await setup({
      config: { command: ["bun", "test"] },
      reply: () => bigOutput("caso"),
    });
    const result = await tool.execute({}, ctx(cwd));
    const out = resultOf(result);
    expect(out.truncated).toBe(true);
    expect(out.output.length).toBeLessThanOrEqual(CAP);
    // O teto vale para o JSON inteiro, não só para o campo `output`.
    expect(result.output.length).toBeLessThanOrEqual(CAP);
  });

  test("falha acima do cap mantém a cauda, onde mora o resumo", async () => {
    const { tool, cwd } = await setup({
      config: { command: ["bun", "test"] },
      reply: () => ({ code: 2, stdout: `inicio\n${bigOutput("caso")}\nFIM-DO-RELATORIO`, stderr: "" }),
    });
    const out = resultOf(await tool.execute({}, ctx(cwd)));
    expect(out.truncated).toBe(true);
    expect(out.output.endsWith("FIM-DO-RELATORIO")).toBe(true);
    expect(out.output.startsWith("inicio")).toBe(false);
  });

  test("JSON devolvido cabe no cap e faz round-trip com caracteres de controle", async () => {
    // Cada `\u0001` vira 6 caracteres no JSON: sem teto do envelope o modelo receberia 30k.
    const { tool, cwd } = await setup({
      config: { command: ["bun", "test"] },
      reply: () => "\u0001".repeat(5_000),
    });
    const result = await tool.execute({}, ctx(cwd));
    expect(result.output.length).toBeLessThanOrEqual(CAP);
    expect(() => JSON.parse(result.output)).not.toThrow();
    const out = resultOf(result);
    expect(out.truncated).toBe(true);
    expect(out.output.length).toBeGreaterThan(0);
    expect(out.output).toMatch(/^\u0001+$/);
  });

  test("segredo na saída é redigido antes do truncamento e não chega ao audit (I-03)", async () => {
    const { tool, audit, cwd } = await setup({
      config: { command: ["bun", "test"] },
      reply: () => `${SECRET}\n${bigOutput("caso")}`,
    });
    const result = await tool.execute({}, ctx(cwd));
    expect(result.output).not.toContain(SECRET);
    expect(result.output).toContain("[REDACTED]");
    expect(readFileSync(join(cwd, "audit.jsonl"), "utf8")).not.toContain(SECRET);
    expect(JSON.stringify(audit.readAll())).not.toContain(SECRET);
  });

  test("argv do resultado é redigido item a item, como no audit", async () => {
    const { tool, cwd } = await setup({
      config: { command: ["bun", "test", SECRET] },
      reply: () => "ok",
    });
    const result = await tool.execute({}, ctx(cwd));
    expect(result.output).not.toContain(SECRET);
    expect(resultOf(result).command).toEqual(["bun", "test", "[REDACTED]"]);
  });
});

describe("run_tests aprovação (classe shell)", () => {
  test("classe shell: pede aprovação em ask/allow-edits e libera em bypass", async () => {
    const { tool } = await setup({ config: { command: ["bun", "test"] } });
    expect(actionClassOf(tool, { name: "run_tests", input: {} })).toBe("shell");
    expect(requiredPermission(tool.manifest)).toBe("execute");
    expect(permissionDecision("ask", "shell")).toBe("ask");
    expect(permissionDecision("allow-edits", "shell")).toBe("ask");
    expect(permissionDecision("bypass", "shell")).toBe("allow");
  });

  test("detalhe material vem da config, com o filter; input inválido não quebra o prompt", async () => {
    const { tool } = await setup({ config: { command: ["bun", "test"] } });
    expect(tool.approvalDetail?.({})).toEqual({ kind: "command", value: "bun test" });
    expect(tool.approvalDetail?.({ filter: "math" })).toEqual({ kind: "command", value: "bun test math" });
    expect(tool.approvalDetail?.({ filter: 7 })).toEqual({ kind: "command", value: "bun test" });
  });

  test("sem run.tests não há detalhe de aprovação para mostrar", async () => {
    const { tool } = await setup({});
    expect(tool.approvalDetail?.({})).toBeUndefined();
  });

  test("no executor: o prompt mostra o comando configurado e o filter", async () => {
    const { tool, mock, audit, cwd } = await setup({ config: { command: ["bun", "test"] }, reply: () => "ok" });
    const requests: ToolPermissionRequest[] = [];
    const executor = new ToolExecutor({
      tools: [tool],
      allow: ["run_tests"],
      audit,
      permissionMode: "ask",
      approveTool: (request) => {
        requests.push(request);
        return false;
      },
    });
    const result = await executor.run(
      ctx(cwd),
      { id: "c1", name: "run_tests", arguments: JSON.stringify({ filter: "math" }) },
    );
    expect(requests[0]?.action).toBe("shell");
    expect(requests[0]?.detail).toEqual({ kind: "command", value: "bun test math" });
    expect(result.isError).toBe(true);
    expect(mock.runCalls).toHaveLength(0);
  });

  test("o prompt redige segredo do comando configurado (I-03)", async () => {
    const { tool, audit, cwd } = await setup({ config: { command: ["bun", "test", SECRET] }, reply: () => "ok" });
    const requests: ToolPermissionRequest[] = [];
    const executor = new ToolExecutor({
      tools: [tool],
      allow: ["run_tests"],
      audit,
      permissionMode: "ask",
      approveTool: (request) => {
        requests.push(request);
        return false;
      },
    });
    await executor.run(ctx(cwd), { id: "c1", name: "run_tests", arguments: "{}" });
    const detail = requests[0]?.detail;
    expect(detail?.value).toContain("bun test");
    expect(detail?.value).toContain("[REDACTED]");
    expect(JSON.stringify(detail)).not.toContain(SECRET);
  });

  test("I-01: fora da allowlist o executor nega mesmo em bypass", async () => {
    const { tool, mock, audit, cwd } = await setup({ config: { command: ["bun", "test"] }, reply: () => "ok" });
    const executor = new ToolExecutor({ tools: [tool], allow: ["read_file"], audit, permissionMode: "bypass" });
    const result = await executor.run(ctx(cwd), { id: "c1", name: "run_tests", arguments: "{}" });
    expect(result.isError).toBe(true);
    expect(mock.runCalls).toHaveLength(0);
  });
});

describe("run_tests registrada no run (#538)", () => {
  test('agent.tools: ["run_tests"] resolve e devolve tests_not_configured sem run.tests', async () => {
    let call = 0;
    const bodies: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        bodies.push(await request.json());
        call += 1;
        return Response.json(call === 1
          ? {
              choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: {
                name: "run_tests",
                arguments: "{}",
              } }] } }],
              usage: { prompt_tokens: 5, completion_tokens: 2 },
            }
          : { choices: [{ message: { content: "sem comando de teste" } }], usage: { prompt_tokens: 6, completion_tokens: 3 } });
      },
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "astro-rt-app-"));
      const configPath = join(dir, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" } },
        models: [{ provider: "mock", id: "mock-1", tags: ["writing-code"], context: 4096 }],
        agent: { model: "mock/mock-1", maxSteps: 4, tools: ["run_tests"] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const report = await runTask({
        approveTool: () => true,
        configPath,
        task: "rode os testes",
        cwd: dir,
        env: testEnv({ TEST_KEY: "test-key" }),
      });
      expect(report.final).toBe("sem comando de teste");
      expect(JSON.stringify(bodies[1])).toContain("run.tests.command");
      expect(JSON.stringify(bodies[1])).toContain("tests_not_configured");
    } finally {
      server.stop(true);
    }
  });
});
