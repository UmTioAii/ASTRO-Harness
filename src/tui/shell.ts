/** `!cmd` da TUI: executa via run_command com allowlist, sandbox e timeout. */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Auditor } from "../audit";
import { allowlistLoadEvents } from "../allowlists";
import { ConfigError } from "../core/config";
import { headerEnvNames } from "../mcp/headers";
import { effectiveOutputCap } from "../output-limit";
import { resolvePermissionMode, type PermissionMode } from "../permissions";
import { loadEffectiveConfig } from "../providers/profiles";
import { redactSecrets } from "../sanitize-external";
import { ToolExecutor, type ToolApprover } from "../tools/executor";
import { configureRunCommand, resolveRunCommandMode, runCommandTool } from "../tools/run-command";
import { shellCommandHash } from "../tools/shell-policy";
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

/** Env names that must not reach a `!cmd` child, rebuilt from the current layer (#650). */
function secretEnvNamesFor(config: ReturnType<typeof loadEffectiveConfig>["config"]): string[] {
  const names: string[] = [];
  for (const provider of Object.values(config.providers)) {
    if (provider.kind === "openai-compat" && typeof provider.credentialRef === "string") {
      names.push(provider.credentialRef);
    }
  }
  for (const server of Object.values(config.mcpServers ?? {})) {
    for (const name of Object.keys(server.env ?? {})) {
      if (!SYSTEM_ENV.has(name.toUpperCase())) names.push(name);
    }
    for (const name of headerEnvNames(server.headers)) {
      if (!SYSTEM_ENV.has(name.toUpperCase())) names.push(name);
    }
  }
  names.push(...webSearchSecretEnvNames(config));
  return names;
}

/**
 * Cria o executor de `!cmd`. Sem `run_command` em `agent.tools` o runner fica
 * desabilitado (I-01); sandbox e timeout vêm da config e da manifest.
 */
export function createShellRunner(opts: ShellOptions): ShellRunner {
  // A layer seen once cannot fall back to defaults if deleted later (#650).
  let configSeen = existsSync(opts.configPath);
  const config = loadEffectiveConfig(opts.configPath, {
    allowMissing: opts.allowMissingConfig === true,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  }).config;
  const auditPath = resolve(opts.cwd, config.paths.audit);
  const creationSecretEnvNames = secretEnvNamesFor(config);
  const creationMode = resolvePermissionMode(
    opts.permissionMode?.() ?? (opts.env ?? process.env).ASTRO_PERMISSION_MODE,
    config.permissions.mode,
  );
  // Fail-closed igual ao caminho do app (I-11): host é o default (#599) com
  // aprovação por comando; `sandbox: true`/`"docker"` exige o container.
  const runCommandMode = resolveRunCommandMode(config.tools?.run_command?.sandbox);
  if (!config.agent.tools.includes("run_command")) {
    return {
      enabled: false,
      run: async (command) => {
        const runId = randomUUID();
        const audit = new Auditor(auditPath);
        audit.append({
          run: runId, agent: "default", tipo: "host_shell.decision",
          payload: {
            tool: "run_command", transport: runCommandMode, commandHash: shellCommandHash(command.trim()),
            effect: "deny", origin: "config", stage: "gate", permissionMode: creationMode, reason: "tool_not_allowed",
          },
        });
        return { output: "run_command não está na allowlist de agent.tools", isError: true };
      },
    };
  }
  configureRunCommand({
    mode: runCommandMode,
    ...(config.shell?.default === undefined ? {} : { shellDefault: config.shell.default }),
    ...(config.shell?.rules === undefined ? {} : { rules: config.shell.rules }),
    ...(config.shell?.approvals === undefined ? {} : { approvals: config.shell.approvals }),
    configPath: opts.configPath,
    ...(config.shell?.externalDirectory === undefined ? {} : { externalDirectory: config.shell.externalDirectory }),
  });
  let loadAudited = false;
  // #650: a failed re-read denies instead of reusing the previous view.
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
      const denyForConfig = (reason: string, message: string, transport: string, mode: PermissionMode, code?: string): ShellResult => {
        audit.append({
          run: runId, agent: "default", tipo: "host_shell.decision",
          payload: {
            tool: "run_command", transport, commandHash: shellCommandHash(input),
            effect: "deny", origin: "config", stage: "gate", permissionMode: mode, reason,
            ...(code === undefined ? {} : { code }),
          },
        });
        return { output: message, isError: true };
      };
      let current: typeof config;
      try {
        current = loadEffectiveConfig(opts.configPath, {
          // A seen config cannot silently fall back to defaults when deleted (#650).
          allowMissing: opts.allowMissingConfig === true && !configSeen,
          ...(opts.env === undefined ? {} : { env: opts.env }),
        }).config;
        configSeen = true;
      } catch (error) {
        const code = error instanceof ConfigError && error.code !== undefined
          ? error.code
          : !existsSync(opts.configPath) ? "config_not_found" : "config_read_failed";
        const runtimeMode = resolvePermissionMode(
          opts.permissionMode?.() ?? (opts.env ?? process.env).ASTRO_PERMISSION_MODE,
          config.permissions.mode,
        );
        return denyForConfig(
          "config_unreadable",
          `config_unreadable (${code}): the shell refuses to run without re-reading the config; restore the file and retry`,
          runCommandMode,
          runtimeMode,
          code,
        );
      }
      const currentMode = resolvePermissionMode(
        opts.permissionMode?.() ?? (opts.env ?? process.env).ASTRO_PERMISSION_MODE,
        current.permissions.mode,
      );
      const effectiveRunCommandMode = resolveRunCommandMode(current.tools?.run_command?.sandbox);
      if (!current.agent.tools.includes("run_command")) {
        return denyForConfig(
          "tool_not_allowed",
          "run_command não está na allowlist de agent.tools",
          effectiveRunCommandMode,
          currentMode,
        );
      }
      const shellConfig = current.shell;
      // #474: o modo do executor decide a confirmação extra do host em `bypass`.
      configureRunCommand({
        mode: effectiveRunCommandMode,
        ...(shellConfig?.default === undefined ? {} : { shellDefault: shellConfig.default }),
        ...(shellConfig?.rules === undefined ? {} : { rules: shellConfig.rules }),
        ...(shellConfig?.approvals === undefined ? {} : { approvals: shellConfig.approvals }),
        configPath: opts.configPath,
        ...(shellConfig?.externalDirectory === undefined ? {} : { externalDirectory: shellConfig.externalDirectory }),
      });
      const secretEnvNames = [...new Set([...creationSecretEnvNames, ...secretEnvNamesFor(current)])];
      const modelEntry = current.models.find((model) => `${model.provider}/${model.id}` === current.agent.model);
      const executor = new ToolExecutor({
        tools: [runCommandTool],
        allow: ["run_command"],
        audit,
        // #557: o `!cmd` segue o mesmo modo resolvido do run (D-24) - bypass
        // não pergunta, ask/allow-edits perguntam por comando (ação shell).
        permissionMode: currentMode,
        // `!` segue o mesmo teto de aprovação da sessão (#526).
        ...(current.permissions.approvalTimeoutMs === undefined
          ? {}
          : { approvalTimeoutMs: current.permissions.approvalTimeoutMs }),
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
            outputLimitTokens: effectiveOutputCap(current.outputLimit, modelEntry?.context),
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
