/**
 * Runner de cenários do golden dataset (#59): cases multi-step que precisam de
 * tool events, MCP/web mock e configuração de app, sem rede real. O mock de
 * provider consome `turns` declarados no `scenario.json`; o app roda de verdade
 * (allowlist, ledger, audit, fallback, multi-agent) contra servidores loopback.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../app";
import { validateConfig } from "../config";
import { runHealthCheck, type HealthReport } from "../health";

export interface ScenarioToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScenarioTurn {
  content?: string;
  toolCalls?: ScenarioToolCall[];
}

export interface ScenarioMcpServer {
  tools: Array<{ name: string; description?: string; text: string }>;
  /** Responde 500 em `tools/call` (transporte cai e o run não aborta). */
  failCall?: boolean;
}

export interface ScenarioSearchServer {
  results: Array<{ title: string; url: string; snippet: string }>;
  /** Primeira chamada responde 429 com `Retry-After: 0` (retry determinístico). */
  retryOnce?: boolean;
}

export interface ScenarioPageServer {
  html: string;
}

export interface ScenarioExpectations {
  /** Texto final exato do run. */
  final?: string;
  /** Mensagem que o run deve lançar (case de falha esperada). */
  error?: string;
  /** Tipos de evento de audit que precisam existir. */
  audit?: string[];
  /** Substrings que precisam existir no audit bruto. */
  auditText?: string[];
  /** Tipos de evento que não podem existir. */
  auditAbsent?: string[];
  /** Substrings que não podem existir no audit bruto. */
  auditTextAbsent?: string[];
  /** Número exato de chamadas ao provider. */
  requests?: number;
  /** Modelos enviados ao provider, na ordem. */
  models?: string[];
  /** Substrings que precisam existir em algum request ao provider (resultado de tool). */
  requestsContain?: string[];
  /** Tools que não podem ser expostas ao modelo (allowlist). */
  toolsAbsent?: string[];
  /** Número exato de chamadas ao backend de web_search. */
  searchRequests?: number;
  /** Agentes que precisam aparecer no run. */
  agents?: string[];
  /** Arquivos que não podem existir no workspace. */
  absentFiles?: string[];
  /** Resultado de `runHealthCheck` (kind=health). */
  health?: { status: string; checks?: Record<string, string> };
}

export interface ScenarioSpec {
  schema: 1;
  kind?: "app" | "health";
  /** Overrides profundos sobre a config base (placeholders inclusos). */
  config?: Record<string, unknown>;
  env?: Record<string, string>;
  turns?: ScenarioTurn[];
  mcp?: ScenarioMcpServer;
  search?: ScenarioSearchServer;
  page?: ScenarioPageServer;
  expect?: ScenarioExpectations;
}

export interface ScenarioResult {
  tokens: number;
  diffSummary: string[];
}

interface MockServer {
  stop(force?: boolean): void;
}

interface ProviderState {
  bodies: unknown[];
  models: string[];
  calls: number;
}

interface SearchState {
  requests: number;
}

interface AuditEventLike {
  tipo?: unknown;
}

const BASE_CONFIG: Record<string, unknown> = {
  providers: {
    mock: { kind: "openai-compat", baseUrl: "{{providerUrl}}", credentialRef: "EVAL_KEY" },
  },
  models: [{
    provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 8192,
    capabilities: { tools: true },
  }],
  agent: { model: "mock/mock-1", maxSteps: 8, tools: ["read_file", "write_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

function substituteString(value: string, vars: Record<string, string>): string {
  return value.replace(PLACEHOLDER, (match, name: string) => vars[name] ?? match);
}

function substitute<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === "string") return substituteString(value, vars) as T;
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, vars)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substitute(entry, vars)]),
    ) as T;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge profundo: objetos combinam, listas e escalares substituem. */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

/** Provider OpenAI-compat determinístico: uma resposta por turno declarado. */
function startProvider(turns: ScenarioTurn[], state: ProviderState): { server: MockServer; url: string } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "GET") {
        // health check (F6-6): GET /models
        return Response.json({ data: [{ id: "mock-1" }] });
      }
      const body = (await req.json()) as { model?: string };
      state.bodies.push(body);
      state.models.push(body.model ?? "");
      const turn = turns[state.calls];
      state.calls += 1;
      if (turn === undefined) {
        return Response.json({ error: { message: "cenário sem turno declarado" } }, { status: 400 });
      }
      const toolCalls = (turn.toolCalls ?? []).map((call, index) => ({
        id: `c${state.calls}_${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
      return Response.json({
        choices: [{
          message: {
            content: turn.content ?? "",
            ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/v1` };
}

/** Servidor primário em outage (fallback C6). */
function startDownServer(): { server: MockServer; url: string } {
  const server = Bun.serve({ port: 0, fetch: () => new Response("outage", { status: 500 }) });
  return { server, url: `http://127.0.0.1:${server.port}/v1` };
}

/** Servidor MCP streamable HTTP mínimo (initialize, tools/list, tools/call). */
function startMcp(spec: ScenarioMcpServer): { server: MockServer; url: string } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        id?: number | string;
        method?: string;
        params?: { name?: string };
      };
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "eval-mcp", version: "1" },
          },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            tools: spec.tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? tool.name,
              inputSchema: { type: "object" },
            })),
          },
        });
      }
      if (body.method === "tools/call") {
        if (spec.failCall === true) return new Response("mcp disconnected", { status: 500 });
        const tool = spec.tools.find((entry) => entry.name === body.params?.name);
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: tool?.text ?? "" }] },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { message: "método desconhecido" } }, { status: 400 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/mcp` };
}

/** Backend web_search mock (formato Exa) com 429 opcional na primeira chamada. */
function startSearch(spec: ScenarioSearchServer, state: SearchState): { server: MockServer; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      state.requests += 1;
      if (spec.retryOnce === true && state.requests === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return Response.json({
        results: spec.results.map((result) => ({ title: result.title, url: result.url, text: result.snippet })),
      });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

/** Página HTML para web_fetch. */
function startPage(spec: ScenarioPageServer): { server: MockServer; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(spec.html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  return { server, url: `http://127.0.0.1:${server.port}/page` };
}

function readAudit(cwd: string): { text: string; events: AuditEventLike[] } {
  const path = join(cwd, ".astro", "audit.jsonl");
  if (!existsSync(path)) return { text: "", events: [] };
  const text = readFileSync(path, "utf8");
  const events = text.trim() === ""
    ? []
    : text.trim().split("\n").map((line) => JSON.parse(line) as AuditEventLike);
  return { text, events };
}

interface Observation {
  cwd: string;
  final?: string;
  error?: string;
  auditText: string;
  auditEvents: AuditEventLike[];
  models: string[];
  bodies: unknown[];
  searchRequests: number;
  agents: string[];
  health?: HealthReport;
}

function checkExpectations(expect: ScenarioExpectations, obs: Observation): string[] {
  const diff: string[] = [];
  if (expect.error !== undefined) {
    if (obs.error === undefined) diff.push(`erro esperado não ocorreu: ${expect.error}`);
    else if (!obs.error.includes(expect.error)) diff.push(`erro "${obs.error}" não contém "${expect.error}"`);
  } else if (obs.error !== undefined) {
    diff.push(`erro na execução: ${obs.error}`);
  }
  if (expect.final !== undefined && obs.final !== expect.final) {
    diff.push(`final divergente: esperado "${expect.final}", recebido "${obs.final ?? "(sem final)"}"`);
  }
  const types = new Set(obs.auditEvents.map((event) => (typeof event.tipo === "string" ? event.tipo : "")));
  for (const tipo of expect.audit ?? []) {
    if (!types.has(tipo)) diff.push(`audit sem evento "${tipo}"`);
  }
  for (const tipo of expect.auditAbsent ?? []) {
    if (types.has(tipo)) diff.push(`audit contém evento proibido "${tipo}"`);
  }
  for (const needle of expect.auditText ?? []) {
    if (!obs.auditText.includes(needle)) diff.push(`audit sem "${needle}"`);
  }
  for (const needle of expect.auditTextAbsent ?? []) {
    if (obs.auditText.includes(needle)) diff.push(`audit contém "${needle}"`);
  }
  if (expect.requests !== undefined && obs.bodies.length !== expect.requests) {
    diff.push(`requests: esperado ${expect.requests}, recebido ${obs.bodies.length}`);
  }
  if (expect.models !== undefined && JSON.stringify(obs.models) !== JSON.stringify(expect.models)) {
    diff.push(`models: esperado ${JSON.stringify(expect.models)}, recebido ${JSON.stringify(obs.models)}`);
  }
  const bodiesText = JSON.stringify(obs.bodies);
  for (const needle of expect.requestsContain ?? []) {
    if (!bodiesText.includes(needle)) diff.push(`requests sem "${needle}"`);
  }
  const exposedTools = obs.bodies.flatMap((body) => {
    if (!isRecord(body) || !Array.isArray(body.tools)) return [];
    return body.tools.flatMap((tool) => {
      if (!isRecord(tool) || !isRecord(tool.function)) return [];
      return typeof tool.function.name === "string" ? [tool.function.name] : [];
    });
  });
  for (const name of expect.toolsAbsent ?? []) {
    if (exposedTools.includes(name)) diff.push(`tool "${name}" não deveria ser exposta ao modelo`);
  }
  if (expect.searchRequests !== undefined && obs.searchRequests !== expect.searchRequests) {
    diff.push(`web_search requests: esperado ${expect.searchRequests}, recebido ${obs.searchRequests}`);
  }
  for (const agent of expect.agents ?? []) {
    if (!obs.agents.includes(agent)) diff.push(`agente "${agent}" ausente (${obs.agents.join(", ")})`);
  }
  for (const file of expect.absentFiles ?? []) {
    if (existsSync(join(obs.cwd, file))) diff.push(`${file}: não deveria existir`);
  }
  if (expect.health !== undefined) {
    if (obs.health === undefined) diff.push("health: relatório ausente");
    else {
      if (obs.health.status !== expect.health.status) {
        diff.push(`health.status: esperado "${expect.health.status}", recebido "${obs.health.status}"`);
      }
      for (const [name, status] of Object.entries(expect.health.checks ?? {})) {
        const check = obs.health.checks.find((entry) => entry.name === name);
        if (check === undefined) diff.push(`health sem check "${name}"`);
        else if (check.status !== status) diff.push(`health check "${name}": esperado ${status}, recebido ${check.status}`);
      }
    }
  }
  return diff;
}

/** Executa um `scenario.json`; o harness compara os arquivos esperados depois. */
export async function runScenario(
  spec: ScenarioSpec,
  opts: { cwd: string; task: string },
): Promise<ScenarioResult> {
  if (spec.schema !== 1) throw new Error(`scenario schema inválido: ${String(spec.schema)}`);
  const kind = spec.kind ?? "app";
  if (kind !== "app" && kind !== "health") throw new Error(`scenario kind inválido: ${String(kind)}`);
  if (kind === "app" && !Array.isArray(spec.turns)) throw new Error("scenario app exige turns[]");

  const servers: MockServer[] = [];
  const providerState: ProviderState = { bodies: [], models: [], calls: 0 };
  const searchState: SearchState = { requests: 0 };
  const vars: Record<string, string> = {};
  // Os mocks falam loopback; a config do golden não deve ir à rede pública (I-11).
  const previousPrivate = process.env.ASTRO_ALLOW_PRIVATE_URLS;
  process.env.ASTRO_ALLOW_PRIVATE_URLS = "1";
  try {
    const page = spec.page === undefined ? undefined : startPage(spec.page);
    if (page !== undefined) { servers.push(page.server); vars.pageUrl = page.url; }
    const search = spec.search === undefined ? undefined : startSearch(spec.search, searchState);
    if (search !== undefined) { servers.push(search.server); vars.searchUrl = search.url; }
    const mcp = spec.mcp === undefined ? undefined : startMcp(spec.mcp);
    if (mcp !== undefined) { servers.push(mcp.server); vars.mcpUrl = mcp.url; }
    const down = startDownServer();
    servers.push(down.server);
    vars.providerDownUrl = down.url;

    const turns = substitute(spec.turns ?? [], vars);
    const provider = startProvider(turns, providerState);
    servers.push(provider.server);
    vars.providerUrl = provider.url;

    const rawConfig = substitute(deepMerge(BASE_CONFIG, spec.config ?? {}), vars);
    const configPath = join(opts.cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), "utf8");

    const env: Record<string, string> = { EVAL_KEY: "eval-provider-secret", ...spec.env };
    let report: Awaited<ReturnType<typeof runTask>> | undefined;
    let error: string | undefined;
    let health: HealthReport | undefined;

    if (kind === "health") {
      health = await runHealthCheck(validateConfig(rawConfig), env, { timeoutMs: 2_000 });
    } else {
      try {
        report = await runTask({
          configPath,
          task: opts.task,
          cwd: opts.cwd,
          env,
          approveTool: () => true,
          approveSwap: () => true,
          // O golden usa sempre o provider/mock do scenario.json, nunca a seleção salva no ASTRO_HOME.
          ignoreStoredSelection: true,
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }

    const audit = readAudit(opts.cwd);
    const observation: Observation = {
      cwd: opts.cwd,
      ...(report === undefined ? {} : { final: report.final }),
      ...(error === undefined ? {} : { error }),
      auditText: audit.text,
      auditEvents: audit.events,
      models: providerState.models,
      bodies: providerState.bodies,
      searchRequests: searchState.requests,
      agents: report?.agentsUsed ?? [],
      ...(health === undefined ? {} : { health }),
    };
    const diffSummary = checkExpectations(spec.expect ?? {}, observation);
    // I-03: valor de credencial de cenário nunca pode aparecer no audit.
    for (const [name, value] of Object.entries(env)) {
      if (/KEY$/i.test(name) && value.length >= 8 && audit.text.includes(value)) {
        diffSummary.push(`segredo de "${name}" apareceu no audit`);
      }
    }
    return { tokens: report === undefined ? 0 : report.tokensIn + report.tokensOut, diffSummary };
  } finally {
    for (const server of servers.reverse()) {
      try { server.stop(true); } catch { /* servidor já parado */ }
    }
    if (previousPrivate === undefined) delete process.env.ASTRO_ALLOW_PRIVATE_URLS;
    else process.env.ASTRO_ALLOW_PRIVATE_URLS = previousPrivate;
  }
}
