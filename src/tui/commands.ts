/** Comandos de barra compartilhados pelo REPL e pela TUI: puro, sem React. */
import { HELP_TEXT, modeListText, resolveModeCommand, resolveShellCommand, unknownCommandMessage, type ReplCommand } from "../chat/commands";
import { detailsLines, providerLine, type ChatSession } from "../chat/repl";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES } from "../permissions";
import { toSessionRecord } from "../chat/store";
import type { SessionApi, SessionSummary as ApiSessionSummary } from "../chat/session-api";
import { redactSecrets } from "../sanitize-external";
import { exportSession } from "../chat/export";
import { initAgents } from "../chat/init";
import { usageLines } from "../chat/usage";
import { DEFAULT_MEMORY_MAX_CHARS, loadMemory, memoryReport } from "../memory";
import { THEMES, isTheme, type Theme } from "./theme";
import { detectHostShells } from "../tools/host-shell";
import {
  EDITABLE_CONFIG_KEYS,
  isEditableConfigKey,
  parseConfigEditValue,
} from "../core/config-edit";

export type EntryKind = "user" | "assistant" | "info" | "error" | "shell";

export interface Entry {
  kind: EntryKind;
  text: string;
  /** Estado da sessão (#480): cinza e uma vez por sessão; comando comum não deduplica. */
  state?: boolean;
  /** Bloco shell (#560): comando executado e metadados do cabeçalho (cwd/exit). */
  shell?: { command: string; cwd: string; exitLabel: string; isError: boolean };
}

export interface CommandState {
  lastFile?: string;
  /** Tema ativo e aplicador (persiste + troca ao vivo) para `/theme` (#64). */
  theme?: Theme;
  setTheme?(theme: Theme): void;
}

export interface CommandOutcome {
  entries: Entry[];
  exit?: boolean;
  /** Caminho gravado; `null` quando a gravação falhou (limpa o anterior). */
  lastFile?: string | null;
  /** Abre a tela de providers com o modo inicial. */
  openProviders?: { mode: "list" | "add" | "edit" | "remove"; target?: string };
  /** Abre a tela de configuração (`/config`, #273). */
  openConfig?: boolean;
  /** Abre o modal de sessões (`/sessions`, #64). */
  openSessions?: boolean;
  /** Abre a tela de log (`/log`, #514): `null` = buffer inteiro, número = últimas n linhas. */
  openLog?: number | null;
}

type SlashCommand = Exclude<ReplCommand, { kind: "prompt" } | { kind: "empty" }>;

export interface RunCommandOptions {
  sessionApi?: SessionApi;
  cwd?: string;
  resumeId?: string;
  /** Shells presentes na máquina (#474); default = `detectHostShells()` (injetável no teste). */
  availableShells?: readonly string[];
}

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Executa um comando que não é turno; devolve entradas para a UI renderizar. */
export async function runCommand(
  command: SlashCommand,
  session: ChatSession,
  state: CommandState,
  options: RunCommandOptions = {},
): Promise<CommandOutcome> {
  const { sessionApi, resumeId, cwd = process.cwd() } = options;
  switch (command.kind) {
    case "help":
      return { entries: [{ kind: "info", text: HELP_TEXT }] };
    case "clear":
      session.clear();
      return { entries: [{ kind: "info", text: "contexto limpo" }] };
    case "exit":
      return { entries: [], exit: true };
    case "unknown":
      return { entries: [{ kind: "info", text: unknownCommandMessage(command.raw) }] };
    case "attach":
    case "paste":
    case "detach":
      return { entries: [{ kind: "info", text: "anexos: use /attach, /paste ou /detach" }] };
    case "model": {
      if (command.model === undefined) {
        return { entries: [{ kind: "info", text: session.listModels().join("\n") }] };
      }
      try {
        return { entries: [{ kind: "info", text: `modelo: ${session.setModel(command.model)}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "mode": {
      const current = session.permissionMode?.() ?? DEFAULT_PERMISSION_MODE;
      const action = resolveModeCommand(command, current, session.setPermissionMode !== undefined);
      if (action.kind === "list") {
        return { entries: [{ kind: "info", text: modeListText(action.current) }] };
      }
      if (action.kind === "invalid") {
        return { entries: [{ kind: "error", text: `modo inválido: ${action.mode} (use ${PERMISSION_MODES.join(", ")})` }] };
      }
      if (action.kind === "needs-confirm") {
        return { entries: [{ kind: "error", text: "modo bypass não ativado: tools executariam sem aprovação — confirme com /mode bypass confirm" }] };
      }
      if (action.kind === "unsupported" || session.setPermissionMode === undefined) {
        return { entries: [{ kind: "error", text: "esta sessão não aceita trocar o modo de permissão" }] };
      }
      try {
        return { entries: [{ kind: "info", text: `modo: ${session.setPermissionMode(action.mode)}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "shell": {
      const available = options.availableShells ?? detectHostShells();
      const action = resolveShellCommand(command, available, session.applyConfigEdits !== undefined);
      if (action.kind === "list") {
        const text = available.length === 0
          ? "nenhum shell suportado encontrado no PATH (pwsh, powershell, cmd, bash, zsh, sh)"
          : `shells do host: ${available.join(", ")}\nuso: /shell <shell> confirm (grava shell.default)`;
        return { entries: [{ kind: "info", text }] };
      }
      if (action.kind === "invalid") {
        return {
          entries: [{
            kind: "error",
            text: `shell indisponível: ${action.shell} (presentes: ${action.shells.join(", ") || "nenhum"})`,
          }],
        };
      }
      if (action.kind === "needs-confirm") {
        return {
          entries: [{
            kind: "error",
            text: `shell.default não alterado: confirme com /shell ${action.shell} confirm`,
          }],
        };
      }
      if (action.kind === "unsupported") {
        return { entries: [{ kind: "error", text: "esta sessão não aceita editar a config" }] };
      }
      try {
        session.applyConfigEdits!({ "shell.default": action.shell });
        return { entries: [{ kind: "info", text: `shell.default: ${action.shell} (gravado na config)` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "config": {
      // /config <chave> <valor> na TUI aplica direto (paridade com o REPL, #558);
      // sem argumentos abre a tela.
      if (command.key !== undefined) {
        if (session.applyConfigEdits === undefined) {
          return { entries: [{ kind: "error", text: "esta sessão não aceita editar a config" }] };
        }
        if (!isEditableConfigKey(command.key)) {
          return { entries: [{ kind: "error", text: `chave não editável via /config: "${command.key}" — editáveis: ${EDITABLE_CONFIG_KEYS.join(", ")}` }] };
        }
        if ((command.rawValue ?? "").trim() === "") {
          return { entries: [{ kind: "error", text: `uso: /config ${command.key} <valor> — editáveis: ${EDITABLE_CONFIG_KEYS.join(", ")}` }] };
        }
        try {
          const key = command.key;
          const value = parseConfigEditValue(key, command.rawValue ?? "");
          session.applyConfigEdits({ [key]: command.rawValue ?? "" });
          return { entries: [{ kind: "info", text: `salvo: ${key} = ${value === null ? "null" : String(value)} (gravado na config)` }] };
        } catch (error) {
          return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
        }
      }
      return { entries: [], openConfig: true };
    }
    case "theme": {
      const current = state.theme ?? "dark";
      if (command.theme === undefined) {
        const lines = THEMES.map((theme) => `${theme === current ? "→" : " "} ${theme}`);
        return { entries: [{ kind: "info", text: `${lines.join("\n")}\nativo: ${current}` }] };
      }
      if (!isTheme(command.theme)) {
        // não ecoa o argumento: ele pode ser um segredo colado por engano (I-03)
        return { entries: [{ kind: "error", text: `tema inválido (use ${THEMES.join(", ")})` }] };
      }
      if (state.setTheme === undefined) {
        return { entries: [{ kind: "error", text: "tema indisponível nesta sessão" }] };
      }
      try {
        state.setTheme(command.theme);
        return { entries: [{ kind: "info", text: `tema: ${command.theme}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "usage": {
      try {
        return { entries: [{ kind: "info", text: usageLines(session.snapshot(), session.budgetStatus?.()).join("\n") }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "memory": {
      try {
        const snapshot = loadMemory({ cwd, maxChars: session.memoryMaxChars?.() ?? DEFAULT_MEMORY_MAX_CHARS });
        return { entries: [{ kind: "info", text: memoryReport(snapshot, command.pathsOnly === true ? { pathsOnly: true } : {}) }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "log": {
      // o buffer vive no app (memória da sessão); aqui só abrimos a tela (#514)
      if (command.arg === undefined) return { entries: [], openLog: null };
      const n = Number(command.arg);
      // isSafeInteger barra arg gigante (vira Infinity) além de 0/negativo/quebrado
      if (!/^\d+$/.test(command.arg) || !Number.isSafeInteger(n) || n < 1) {
        return { entries: [{ kind: "error", text: "uso: /log [n] — n inteiro ≥ 1" }] };
      }
      return { entries: [], openLog: n };
    }
    case "providers":
      return { entries: [], openProviders: { mode: "list" } };
    case "provider": {
      if (command.action === "use") {
        if (command.target === undefined) {
          return { entries: [], openProviders: { mode: "list" } };
        }
        try {
          return { entries: [{ kind: "info", text: `provider: ${session.setProvider(command.target)}` }] };
        } catch (error) {
          return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
        }
      }
      if (command.action === "list") {
        return { entries: [], openProviders: { mode: "list" } };
      }
      if (command.target === undefined) {
        return { entries: [], openProviders: { mode: command.action } };
      }
      return { entries: [], openProviders: { mode: command.action, target: command.target } };
    }
    case "sessions": {
      if (sessionApi === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      if (command.delete !== undefined) {
        // a exclusão na TUI é uma tecla do modal, com confirmação (#366)
        return { entries: [{ kind: "info", text: "na TUI, use /sessions e pressione d para excluir" }] };
      }
      // na TUI o modal lista/renomeia/exclui/retoma; o REPL mantém a listagem em texto (#64)
      return { entries: [], openSessions: true };
    }
    case "resume": {
      if (sessionApi === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      if (command.ref === undefined) {
        return { entries: [{ kind: "info", text: "uso: /resume <número|id> (veja /sessions)" }] };
      }
      try {
        let chosen: ApiSessionSummary | undefined;
        if (resumeId === undefined && /^\d+$/.test(command.ref)) {
          chosen = sessionApi.list()[Number(command.ref) - 1]; // sempre relê a lista (#64)
          if (chosen === undefined) {
            return { entries: [{ kind: "info", text: "índice fora da lista; use /sessions" }] };
          }
        }
        const loaded = sessionApi.load(resumeId ?? chosen?.id ?? command.ref);
        session.resume(loaded);
        state.lastFile = undefined;
        return {
          entries: [{ kind: "info", text: `sessão retomada: ${loaded.id} (${loaded.turns} turnos)` }],
          lastFile: null,
        };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "compact": {
      try {
        const summary = await session.compact(command.force === true);
        return { entries: [{ kind: "info", text: summary }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "export": {
      try {
        const path = exportSession(session.snapshot(), cwd, command.path);
        return { entries: [{ kind: "info", text: `sessão exportada em ${path}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "init": {
      try {
        const path = initAgents(cwd);
        return { entries: [{ kind: "info", text: `AGENTS.md criado em ${path}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "session":
    case "details": {
      const lines = detailsLines(session.snapshot(), state.lastFile);
      if (sessionApi === undefined) lines[lines.length - 1] = "arquivo: sem persistência";
      return { entries: [{ kind: "info", text: lines.join("\n") }] };
    }
    case "save": {
      if (sessionApi === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      try {
        sessionApi.save(toSessionRecord(session.snapshot()));
        return {
          entries: [{ kind: "info", text: `sessão salva em ${sessionApi.databasePath}` }],
          lastFile: sessionApi.databasePath,
        };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }], lastFile: null };
      }
    }
  }
}
