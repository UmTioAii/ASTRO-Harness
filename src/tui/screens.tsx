/**
 * Full-screen TUI screens (#595): log, diff, sessions, model picker, config and
 * providers. `app.tsx` decides which one is open; this module owns their
 * behaviour so the composer screen stays small.
 */
import type { ReactElement } from "react";
import type { RefObject } from "react";
import { Text } from "ink";
import { activeSessionRefusal } from "../chat/store";
import type { SessionApi, SessionSummary } from "../chat/session-api";
import type { ChatSession } from "../chat/repl";
import type { PermissionMode } from "../permissions";
import type { ProfileManager } from "../providers/profile-manager";
import { recordRecent, type ModelOption } from "./models";
import { saveTuiConfig, type ThemeColors } from "./theme";
import { ConfigScreen } from "./config-screen";
import { DiffViewer } from "./diff-viewer";
import { LogScreen } from "./log-screen";
import { ModelPicker } from "./model-picker";
import { ProviderScreen } from "./provider-screen";
import { SessionPicker } from "./session-picker";
import { messageOf } from "./entries";
import { errorLine } from "./error-hint";
import { loadTrustedStore, trustStatePath } from "../trust";
import { parseConfigEditValue } from "../core/config-edit";
import { runCommand, type CommandState, type Entry } from "./commands";

export type ProviderMode = "list" | "add" | "edit" | "remove";

export interface ScreenState {
  log?: { n?: number };
  diffOpen: boolean;
  question?: { text: string; diff?: { path: string; content: string } };
  sessionsOpen: boolean;
  sessions: readonly SessionSummary[];
  modelsOpen: boolean;
  configOpen: boolean;
  providers?: { mode: ProviderMode; target?: string };
}

export interface ScreenRuntime {
  session: ChatSession;
  cwd: string;
  sessionApi?: SessionApi;
  manager?: ProfileManager;
  colors: ThemeColors;
  statusModel: string;
  favorites: readonly string[];
  recents: readonly string[];
  commandState: RefObject<CommandState>;
  /** Appends with the session-state dedupe (#480). */
  append(entries: Entry[]): void;
  /** Raw append for errors and state lines. */
  push(entries: Entry[]): void;
  syncStatus(): void;
  logSessionHeader(): void;
  logHeader(): string;
  logLines(n?: number): string[];
  refreshHealth(): void;
  invalidateHealth(): void;
  setSessions(list: SessionSummary[]): void;
  setFavorites(next: string[]): void;
  setRecents(next: string[]): void;
  saveSecret?: (providerId: string, secret: string) => string;
  discardSecret?: (ref: string) => void;
  finish(): void;
  closeLog(): void;
  closeDiff(): void;
  closeSessions(): void;
  closeModels(): void;
  closeConfig(): void;
  closeProviders(): void;
}

/** Persists the last model without taking the activation down if the file fails. */
export function persistLastModel(cwd: string, model: string, onWarning?: (message: string) => void): void {
  try {
    saveTuiConfig(cwd, { lastModel: model });
  } catch {
    const message = "aviso: não foi possível salvar o último modelo da TUI";
    if (onWarning === undefined) console.error(message);
    else onWarning(message);
  }
}

/** Activates the provider on the session and persists the last model without failing the activation. */
export function activateProvider(
  session: Pick<ChatSession, "reload" | "setProvider" | "snapshot">,
  cwd: string,
  id: string,
  onWarning?: (message: string) => void,
): void {
  session.reload?.();
  session.setProvider(id);
  persistLastModel(cwd, session.snapshot().model, onWarning);
}

function pickerModels(session: ChatSession): ModelOption[] {
  const info = session.listModelInfo?.();
  if (info !== undefined) return info;
  return session.listModels().map((ref) => {
    const slash = ref.indexOf("/");
    const provider = slash < 0 ? ref : ref.slice(0, slash);
    const id = slash < 0 ? ref : ref.slice(slash + 1);
    return { ref, provider, id, tags: [], status: "unknown" };
  });
}

/** Changes the session model and persists it (picker and /provider share this, #555). */
function selectModel(runtime: ScreenRuntime, ref: string): void {
  try {
    const model = runtime.session.setModel(ref);
    const nextRecents = recordRecent(model, runtime.recents);
    try {
      saveTuiConfig(runtime.cwd, { lastModel: model, recentModels: nextRecents });
    } catch (error) {
      runtime.push([{ kind: "error", text: errorLine(error, messageOf(error)) }]);
    }
    runtime.setRecents(nextRecents);
    runtime.syncStatus();
    runtime.push([{ kind: "info", text: `modelo: ${model}` }]);
    runtime.logSessionHeader(); // new session header goes to /log (#514)
  } catch (error) {
    runtime.push([{ kind: "error", text: errorLine(error, messageOf(error)) }]);
  }
}

function resume(runtime: ScreenRuntime, chosen: SessionSummary): void {
  void (async () => {
    const outcome = await runCommand(
      { kind: "resume", ref: chosen.id }, runtime.session, runtime.commandState.current,
      { cwd: runtime.cwd, sessionApi: runtime.sessionApi, resumeId: chosen.id },
    );
    if (outcome.lastFile !== undefined) runtime.commandState.current.lastFile = outcome.lastFile ?? undefined;
    const added = [...outcome.entries];
    const failed = added.some((entry) => entry.kind === "error");
    if (!failed) {
      try {
        saveTuiConfig(runtime.cwd, { lastModel: runtime.session.snapshot().model });
      } catch (error) {
        added.push({ kind: "error", text: errorLine(error, messageOf(error)) });
      }
    }
    runtime.append(added);
    runtime.syncStatus();
    runtime.closeSessions();
  })().catch((error: unknown) => {
    runtime.push([{ kind: "error", text: errorLine(error, messageOf(error)) }]);
    runtime.closeSessions();
  });
}

/**
 * The open screen, in the historical precedence: log, diff, sessions, model,
 * config, providers. Returns `undefined` when the composer owns the screen.
 */
export function renderScreen(state: ScreenState, runtime: ScreenRuntime): ReactElement | undefined {
  const { colors, session } = runtime;

  if (state.log !== undefined) {
    return (
      <LogScreen
        colors={colors}
        header={runtime.logHeader()}
        lines={runtime.logLines(state.log.n)}
        onClose={runtime.closeLog}
      />
    );
  }

  if (state.diffOpen && state.question?.diff !== undefined) {
    return (
      <DiffViewer
        path={state.question.diff.path}
        diff={state.question.diff.content}
        colors={colors}
        onClose={runtime.closeDiff}
      />
    );
  }

  if (state.sessionsOpen) {
    return (
      <SessionPicker
        sessions={state.sessions}
        colors={colors}
        onClose={runtime.closeSessions}
        onExit={runtime.finish}
        onResume={(chosen) => resume(runtime, chosen)}
        onRename={(chosen, name) => {
          if (runtime.sessionApi === undefined) return "sem persistência configurada";
          try {
            runtime.sessionApi.rename(chosen.id, name);
            runtime.setSessions(runtime.sessionApi.list());
            return undefined;
          } catch (error) {
            return `erro: ${messageOf(error)}`;
          }
        }}
        onDelete={(chosen) => {
          if (runtime.sessionApi === undefined) return "sem persistência configurada";
          // the current session stays on auto-save; the resumed origin stays in the lineage (#366)
          const refusal = activeSessionRefusal(session.snapshot(), chosen.id);
          if (refusal !== undefined) return refusal;
          try {
            const deleted = runtime.sessionApi.delete(chosen.id);
            runtime.setSessions(runtime.sessionApi.list());
            return deleted ? undefined : "sessão não encontrada";
          } catch (error) {
            return `erro: ${messageOf(error)}`;
          }
        }}
      />
    );
  }

  if (state.modelsOpen) {
    return (
      <ModelPicker
        models={pickerModels(session)}
        favorites={[...runtime.favorites]}
        recents={[...runtime.recents]}
        colors={colors}
        onClose={runtime.closeModels}
        onExit={runtime.finish}
        onSelect={(ref) => {
          selectModel(runtime, ref);
          runtime.closeModels();
        }}
        onFavorite={(next) => {
          try {
            saveTuiConfig(runtime.cwd, { favoriteModels: next });
            runtime.setFavorites(next);
          } catch (error) {
            runtime.push([{ kind: "error", text: errorLine(error, messageOf(error)) }]);
          }
        }}
      />
    );
  }

  if (state.configOpen) {
    const summary = session.configSummary?.();
    if (summary === undefined) {
      return <Text color={colors.error}>tela de configuração indisponível nesta sessão</Text>;
    }
    let trusted: readonly string[] = [];
    try {
      // same source the revocation uses (session env), not the UI's process.env (#267)
      trusted = session.trustedFolders?.() ?? loadTrustedStore(trustStatePath()).folders;
    } catch {
      trusted = []; // an invalid trust store does not block the config view
    }
    return (
      <ConfigScreen
        colors={colors}
        summary={summary}
        trustedFolders={trusted}
        onClose={runtime.closeConfig}
        onSaveMode={(mode: PermissionMode) => {
          if (session.savePermissionMode === undefined) throw new Error("esta sessão não aceita trocar o modo");
          session.savePermissionMode(mode); // persists in the config + runtime swap (#273)
          runtime.push([{ kind: "info", text: `modo: ${mode} (salvo na config)` }]);
        }}
        onRevokeTrust={(dir) => {
          if (session.revokeTrustedFolder === undefined) throw new Error("esta sessão não aceita revogar trust");
          const removed = session.revokeTrustedFolder(dir); // removes from the global store + audits (#267)
          if (removed) runtime.push([{ kind: "info", text: `trust revogado: ${dir}` }]);
          return removed;
        }}
        onSaveKnob={(key, rawValue) => {
          // validate, write to the file and reload on the session (#558)
          if (session.applyConfigEdits === undefined) throw new Error("esta sessão não aceita editar a config");
          parseConfigEditValue(key, rawValue); // parse first: an error here writes nothing
          session.applyConfigEdits({ [key]: rawValue });
          runtime.push([{ kind: "info", text: `salvo: ${key} = ${rawValue} (gravado na config)` }]);
        }}
      />
    );
  }

  if (state.providers !== undefined && runtime.manager !== undefined) {
    return (
      <ProviderScreen
        manager={runtime.manager}
        colors={colors}
        currentModel={session.model}
        initial={state.providers}
        modelInfo={pickerModels(session)}
        onSelectModel={(ref) => selectModel(runtime, ref)}
        onClose={runtime.closeProviders}
        onActivate={(id) => {
          activateProvider(session, runtime.cwd, id, (text) => {
            runtime.push([{ kind: "error", text }]);
          });
          runtime.syncStatus();
          runtime.push([{ kind: "info", text: `provider: ${session.model}` }]);
          runtime.logSessionHeader(); // new session header goes to /log (#514)
          runtime.refreshHealth();
        }}
        onChanged={() => {
          try {
            session.reload?.();
            runtime.invalidateHealth();
            runtime.syncStatus();
          } catch (error) {
            runtime.push([{ kind: "error", text: errorLine(error, messageOf(error)) }]);
          }
        }}
        {...(session.probeProvider === undefined ? {} : { onTest: (id: string) => session.probeProvider!(id) })}
        {...(session.loginCodex === undefined ? {} : { onLogin: (id: string, signal?: AbortSignal) => session.loginCodex!(id, signal) })}
        {...(runtime.saveSecret === undefined ? {} : { onSaveSecret: runtime.saveSecret })}
        {...(runtime.discardSecret === undefined ? {} : { onDiscardSecret: runtime.discardSecret })}
      />
    );
  }

  return undefined;
}
