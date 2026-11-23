/** `!cmd` da TUI: executa via run_command com allowlist, sandbox e timeout. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Auditor } from "../audit";
import { allowlistLoadEvents } from "../allowlists";
import { headerEnvNames } from "../mcp/headers";
import { effectiveOutputCap } from "../output-limit";
import { resolvePermissionMode, type PermissionMode } from "../permissions";
import { loadEffectiveConfig } from "../providers/profiles";
import { redactSecrets } from "../sanitize-external";
import { ToolExecutor, type ToolApprover } from "../tools/executor";
import { configureRunCommand, resolveRunCommandMode, runCommandTool } from "../tools/run-command";
import { webSearchSecretEnvNames } from "../tools/web-search";

export interface ShellResult {
  output: string;
  isError: boolean;
}

export interface ShellRunner {
  readonly enabled: boolean;
  run(command: string, signal?: AbortSignal): Promise<ShellResult>;
}

export interface ShellOptions {
  configPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowMissingConfig?: boolean;
  /** Aprovador do gate no modo ask; ausente = fail-closed (deny). */
  approveTool?: ToolApprover;
  /**
   * Modo de permissão corrente da sessão (TUI `/mode` em runtime, #271/#557);
   * avaliado a cada `run`. Sem ele, cai em `ASTRO_PERMISSION_MODE` e depois em
   * `permissions.mode` da config — a mesma precedência do run (D-24).
   */
  permissionMode?: () => PermissionMode | undefined;
  /** `allow-critical` da CLI (ADR-0027 slice 5a): path liberado não é mascarado no sandbox. */
  allowCritical?: readonly string[];
  /** `allow-sensitive` da CLI (ADR-0027 slice 5b): reclassifica no gate e audita no load. */
  allowSensitive?: readonly string[];
}

/** Variáveis que o shell precisa manter mesmo se um MCP declarar o mesmo nome. */
const SYSTEM_ENV = new Set([
  "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP",
  "SHELL", "PWD", "LANG", "LC_ALL", "TERM",
]);

/**
 * Cria o executor de `!cmd`. Sem `run_command` em `agent.tools` o runner fica
 * desabilitado (I-01); sandbox e timeout vêm da config e da manifest.
 */
export function createShellRunner(opts: ShellOptions): ShellRunner {
  const config = loadEffectiveConfig(opts.configPath, {
    allowMissing: opts.allowMissingConfig === true,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  }).config;
  if (!config.agent.tools.includes("run_command")) {
    return {
      enabled: false,
      run: async () => ({ output: "run_command não está na allowlist de agent.tools", isError: true }),
    };
  }
  // Fail-closed igual ao caminho do app (I-11): host é o default (#599) com
  // aprovação por comando; `sandbox: true`/`"docker"` exige o container.
  const runCommandMode = resolveRunCommandMode(config.tools?.run_command?.sandbox);
  configureRunCommand({
    mode: runCommandMode,
    ...(config.shell?.default === undefined ? {} : { shellDefault: config.shell.default }),
  });
  const auditPath = resolve(opts.cwd, config.paths.audit);
  const secretEnvNames: string[] = [];
  for (const provider of Object.values(config.providers)) {
    if (provider.kind === "openai-compat" && typeof provider.credentialRef === "string") {
      secretEnvNames.push(provider.credentialRef);
    }
  }
  for (const server of Object.values(config.mcpServers ?? {})) {
    for (const name of Object.keys(server.env ?? {})) {
      if (!SYSTEM_ENV.has(name.toUpperCase())) secretEnvNames.push(name);
    }
    for (const name of headerEnvNames(server.headers)) {
      if (!SYSTEM_ENV.has(name.toUpperCase())) secretEnvNames.push(name);
    }
  }
  secretEnvNames.push(...webSearchSecretEnvNames(config));
  const modelEntry = config.models.find((model) => `${model.provider}/${model.id}` === config.agent.model);
  let loadAudited = false;
  return {
    enabled: true,
    run: async (command, signal) => {
      const input = command.trim();
      if (input === "") return { output: "uso: !<comando>", isError: true };
      // Auditor novo por execução: o seq é local e não colide com a sessão.
      const runId = randomUUID();
      const audit = new Auditor(auditPath);
      if (!loadAudited) {
        loadAudited = true;
        for (const event of allowlistLoadEvents({ allowCritical: opts.allowCritical, allowSensitive: opts.allowSensitive }, opts.cwd)) {
          audit.append({ run: runId, agent: "default", tipo: "security.allowlist_applied", payload: { ...event } });
        }
      }
      const currentMode = resolvePermissionMode(
        opts.permissionMode?.() ?? (opts.env ?? process.env).ASTRO_PERMISSION_MODE,
        config.permissions.mode,
      );
      // #474: o modo do executor decide a confirmação extra do host em `bypass`.
      configureRunCommand({
        mode: runCommandMode,
        ...(config.shell?.default === undefined ? {} : { shellDefault: config.shell.default }),
      });
      const executor = new ToolExecutor({
        tools: [runCommandTool],
        allow: ["run_command"],
        audit,
        // #557: o `!cmd` segue o mesmo modo resolvido do run (D-24) - bypass
        // não pergunta, ask/allow-edits perguntam por comando (ação shell).
        permissionMode: currentMode,
        // `!` segue o mesmo teto de aprovação da sessão (#526).
        ...(config.permissions.approvalTimeoutMs === undefined
          ? {}
          : { approvalTimeoutMs: config.permissions.approvalTimeoutMs }),
        ...(opts.approveTool === undefined ? {} : { approveTool: opts.approveTool }),
      });
      try {
        const result = await executor.run(
          {
            cwd: opts.cwd, run: runId, agent: "default",
            env: opts.env ?? process.env, secretEnvNames,
            ...(opts.allowCritical === undefined ? {} : { allowCritical: opts.allowCritical }),
            ...(opts.allowSensitive === undefined ? {} : { allowSensitive: opts.allowSensitive }),
            // Mesmo cap do run (default quando o agent usa profile de outro modelo).
            outputLimitTokens: effectiveOutputCap(config.outputLimit, modelEntry?.context),
            ...(signal === undefined ? {} : { signal }),
          },
          { id: randomUUID(), name: "run_command", arguments: JSON.stringify({ command: input }) },
        );
        return { output: redactSecrets(result.output), isError: result.isError === true };
      } catch (error) {
        return {
          output: redactSecrets(error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      }
    },
  };
}
