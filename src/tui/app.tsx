/** TUI composition (#595): session state, effects and the four TUIX zones; handlers live in modules. */
import { Box, Static, Text, useWindowSize } from "ink";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ChatSession } from "../chat/repl";
import { toSessionRecord } from "../chat/store";
import type { SessionApi, SessionSummary } from "../chat/session-api";
import { DEFAULT_PERMISSION_MODE } from "../permissions";
import { sanitizeBlockText } from "../sanitize-external";
import type { CommandState, Entry } from "./commands";
import { COMMANDS, completionItems, suggestionWindow } from "./editor";
import type { ApprovalBridge, ApprovalQuestion } from "./approvals";
import type { ShellRunner } from "./shell";
import { budgetColor, footerBase, footerModel, modeColor, packageVersion } from "./footer";
import { appendLog, laneLine, sessionHeaderLine, tailLog } from "./log";
import { errorLine } from "./error-hint";
import { indexFiles } from "./files";
import { providerHealth } from "./health";
import { loadTuiConfig, saveTuiConfig, getThemeColors, type Theme } from "./theme";
import { TOAST_TICK_MS, TOAST_TTL_MS, pruneToasts, pushToast, toastLine, type Toast } from "./toasts";
import { STREAM_THROTTLE_MS } from "./stream";
import { budgetSegment } from "../chat/usage";
import { HISTORY_LIMIT, visibleWindow } from "./history";
import { renderTimelineZones, type TimelineView } from "./timeline";
import { TimelineZone } from "./timeline-zones";
import { EntryLine, messageOf, statusOf, type Status } from "./entries";
import { renderScreen } from "./screens";
import { useTurn } from "./turn";
import { useTuiKeys } from "./keys";
import { useAlarms } from "./alarms";
import { Composer } from "./composer";

export interface TuiAppProps {
  session: ChatSession;
  cwd: string;
  branch?: string;
  sessionApi?: SessionApi;
  approvals?: ApprovalBridge;
  shell?: ShellRunner;
  manager?: import("../providers/profile-manager").ProfileManager;
  onExit?: () => void;
  /** Tempo de vida dos toasts em ms (#64); testes usam valores curtos. */
  toastTtlMs?: number;
  /** Janela do throttle de streaming em ms (#64); default STREAM_THROTTLE_MS. */
  streamThrottleMs?: number;
  /** Entradas do histórico visíveis no <Static> (#64); default HISTORY_LIMIT. */
  historyLimit?: number;
  /** Observer for a completed turn before it enters history (#635). */
  onTimelineEntry?: (entry: Entry) => void;
  /** Salva uma chave digitada no cofre (#350); ausente desabilita o caminho de segredo. */
  saveSecret?: (providerId: string, secret: string) => string;
  /** Desfaz uma credencial criada quando o perfil não pôde ser salvo (#350). */
  discardSecret?: (ref: string) => void;
}

const WELCOME = "astro · /help para comandos · /exit para sair";

export function TuiApp({ session, cwd, branch, sessionApi, approvals, shell, manager, onExit, toastTtlMs = TOAST_TTL_MS, streamThrottleMs = STREAM_THROTTLE_MS, historyLimit = HISTORY_LIMIT, saveSecret, discardSecret, onTimelineEntry }: TuiAppProps): ReactElement {
  const { columns } = useWindowSize();
  const width = columns !== undefined && columns > 0 ? columns : 80;
  const [entries, setEntries] = useState<Entry[]>([{ kind: "info", text: WELCOME }]);
  /** Session state appears once per session (#480): only marked entries dedupe. */
  const appendEntries = (added: Entry[]): void => {
    setEntries((current) => {
      const seen = new Set(current.filter((entry) => entry.state === true).map((entry) => entry.text));
      const fresh = added.filter((entry) => entry.state !== true || !seen.has(entry.text));
      return fresh.length === 0 ? current : [...current, ...fresh];
    });
  };
  const pushEntries = (added: Entry[]): void => {
    setEntries((current) => [...current, ...added]);
  };
  const [question, setQuestion] = useState<ApprovalQuestion | undefined>(() => approvals?.current());
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [input, setInputState] = useState("");
  const inputRef = useRef("");
  const setInput = (update: (current: string) => string): void => {
    inputRef.current = update(inputRef.current);
    setInputState(inputRef.current);
  };
  const [initialConfig] = useState(() => loadTuiConfig(cwd));
  const [theme, setTheme] = useState<Theme>(initialConfig.theme);
  const colors = getThemeColors(theme);
  const persistTheme = (next: Theme): void => {
    // persist before applying: a write failure never leaves the TUI in a theme that does not survive a restart
    saveTuiConfig(cwd, { theme: next });
    setTheme(next);
  };
  const [status, setStatus] = useState<Status>(() => statusOf(session.snapshot()));
  const syncStatus = (): void => setStatus(statusOf(session.snapshot()));
  const healthToken = useRef(0);
  const activeProvider = (): string => session.providerName?.() ?? session.snapshot().model.split("/")[0]!;
  const refreshHealth = async (): Promise<void> => {
    if (session.health === undefined) return;
    const token = ++healthToken.current;
    const provider = activeProvider();
    try {
      const report = await session.health();
      if (token !== healthToken.current) return;
      const state = providerHealth(report, provider);
      // Only health transitions go to /log (#514, docs/tui-layout.md §/log)
      if (state !== undefined) {
        const line = laneLine("saúde", `saúde: ${provider} ${state}`); // separate lane (#560)
        if (lastHealthLogRef.current !== line) {
          lastHealthLogRef.current = line;
          logLine(line);
        }
      }
    } catch {
      // check failed: nothing to log, and no stale health survives (the banner that showed it is gone, #595)
    }
  };
  const [screen, setScreen] = useState<{ mode: "list" | "add" | "edit" | "remove"; target?: string } | undefined>(undefined);
  const [logScreen, setLogScreen] = useState<{ n?: number } | undefined>(undefined); // `/log` screen (#514)
  const [configOpen, setConfigOpen] = useState(false); // `/config` screen (#273)
  const [modelPicker, setModelPicker] = useState(false);
  const [sessionPicker, setSessionPicker] = useState(false); // `/sessions` modal (#64)
  const [diffOpen, setDiffOpen] = useState(false); // approval diff overlay (#64 D2)
  const diffOpenRef = useRef(false);
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [favorites, setFavorites] = useState<string[]>(initialConfig.favoriteModels ?? []);
  const [recents, setRecents] = useState<string[]>(initialConfig.recentModels ?? []);
  const commandState = useRef<CommandState>({});
  // In-memory session log (#514): ring in a ref, never persisted (audit/ledger are the durable source)
  const logRef = useRef<string[]>([]);
  const lastLogHeaderRef = useRef<string | undefined>(undefined);
  const lastHealthLogRef = useRef<string | undefined>(undefined); // only health transitions go to /log (#514)
  const logLine = (line: string): void => {
    logRef.current = appendLog(logRef.current, line);
  };
  const endpointOf = (): string =>
    manager?.list().find((item) => item.id === activeProvider())?.baseUrl ?? "-";
  /** Session header goes to /log (version, provider/model, endpoint); only writes when it changes. */
  const logSessionHeader = (): void => {
    const header = sessionHeaderLine({ version: packageVersion(), model: session.snapshot().model, endpoint: endpointOf() });
    if (lastLogHeaderRef.current === header) return;
    lastLogHeaderRef.current = header;
    logLine(laneLine("sessão", header)); // separate lane in /log (#560)
  };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = (toast: { kind: Toast["kind"]; text: string }): void => {
    setToasts((current) => pushToast(current, toast, Date.now()));
  };
  // History virtualization (#64): Ink's <Static> is append-only by count
  // (items.slice(index)), so the window cut happens in a separate update (effect
  // below), never atomically with the append — otherwise border items would be
  // skipped. The hidden ones become a marker above <Static>.
  const [hiddenEntries, setHiddenEntries] = useState(0);
  useEffect(() => {
    if (entries.length <= historyLimit) return;
    setHiddenEntries((hidden) => hidden + (entries.length - historyLimit));
    setEntries((current) => visibleWindow(current, historyLimit));
  }, [entries.length, historyLimit]);

  // Toasts stay for transient confirmations (copy/export). Errors are inline lines
  // with a next step; no toast duplicating the history (#480).

  // Removes expired toasts; only ticks when something is on screen
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(
      () => setToasts((current) => pruneToasts(current, Date.now(), toastTtlMs)),
      TOAST_TICK_MS,
    );
    return () => clearInterval(timer);
  }, [toasts.length, toastTtlMs]);

  useEffect(() => {
    approvals?.subscribe((pendingQuestion) => {
      setQuestion(pendingQuestion);
      if (pendingQuestion === undefined || pendingQuestion.diff === undefined) {
        // answered or a new question without a diff: the overlay does not stay open
        // (aligns the useInput guard with the overlay render condition)
        diffOpenRef.current = false;
        setDiffOpen(false);
      }
    });
  }, [approvals]);

  useEffect(() => {
    setFiles(indexFiles(cwd));
  }, [cwd]);

  // Session header enters the /log buffer on open (#514)
  useEffect(() => {
    logSessionHeader();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on mount only
  }, []);

  const persist = (report: boolean): { path?: string; failed: boolean } => {
    if (sessionApi === undefined) return { failed: false };
    try {
      sessionApi.save(toSessionRecord(session.snapshot()));
      return { path: sessionApi.databasePath, failed: false };
    } catch (error) {
      if (report) pushEntries([{ kind: "error", text: errorLine(error, messageOf(error)) }]);
      return { failed: true };
    }
  };

  const turn = useTurn({
    session,
    cwd,
    ...(sessionApi === undefined ? {} : { sessionApi }),
    ...(manager === undefined ? {} : { manager }),
    ...(shell === undefined ? {} : { shell }),
    ...(approvals === undefined ? {} : { approvals }),
    streamThrottleMs,
    ...(onTimelineEntry === undefined ? {} : { onTimelineEntry }),
    append: appendEntries,
    push: pushEntries,
    syncStatus,
    persist,
    log: logLine,
    commandState,
    theme,
    setTheme: persistTheme,
    refreshHealth: () => { void refreshHealth(); },
    logSessionHeader,
    openLog: (n) => setLogScreen(n === undefined ? {} : { n }),
    openProviders: (next) => setScreen(next),
    openConfig: () => setConfigOpen(true),
    openSessions: () => {
      setSessionList(sessionApi?.list() ?? []);
      setSessionPicker(true);
    },
    openModelPicker: () => setModelPicker(true),
    ...(onExit === undefined ? {} : { onExit }),
  });

  const { budget } = useAlarms({ session, status, log: logLine, toast: addToast });

  const place = branch === undefined ? cwd : `${cwd} (${branch})`;
  const suggestions = question === undefined ? completionItems(input, COMMANDS, files) : [];
  const selectedIndex = suggestions.length === 0 ? 0 : Math.min(selected, suggestions.length - 1);
  const win = suggestionWindow(suggestions.length, selectedIndex);
  const mode = session.permissionMode?.() ?? DEFAULT_PERMISSION_MODE;

  useTuiKeys({
    suspended: screen !== undefined || modelPicker || configOpen || sessionPicker || diffOpen || logScreen !== undefined,
    ...(approvals === undefined ? {} : { approvals }),
    ...(question === undefined ? {} : { question }),
    diffOpen: diffOpenRef,
    openDiff: () => setDiffOpen(true),
    busy: turn.busy,
    busyRef: turn.busyRef,
    dispatch: turn.dispatch,
    enqueue: turn.enqueue,
    toggleToolOutput: turn.toggleToolOutput,
    toggleThinking: turn.toggleThinking,
    finish: turn.finish,
    session,
    ...(sessionApi === undefined ? {} : { sessionApi }),
    theme,
    append: appendEntries,
    setTheme: persistTheme,
    inputRef,
    setInput,
    suggestions,
    selectedIndex,
    setSelected,
    cwd,
    setFiles,
  });

  const screenView = renderScreen(
    {
      ...(logScreen === undefined ? {} : { log: logScreen }),
      diffOpen,
      ...(question === undefined ? {} : { question }),
      sessionsOpen: sessionPicker,
      sessions: sessionList,
      modelsOpen: modelPicker,
      configOpen,
      ...(screen === undefined ? {} : { providers: screen }),
    },
    {
      session,
      cwd,
      ...(sessionApi === undefined ? {} : { sessionApi }),
      ...(manager === undefined ? {} : { manager }),
      colors,
      statusModel: status.model,
      favorites,
      recents,
      commandState,
      append: appendEntries,
      push: pushEntries,
      syncStatus,
      logSessionHeader,
      logHeader: () => sessionHeaderLine({ version: packageVersion(), model: status.model, endpoint: endpointOf() }),
      logLines: (n) => tailLog(logRef.current, n),
      refreshHealth: () => { void refreshHealth(); },
      invalidateHealth: () => { healthToken.current++; },
      setSessions: setSessionList,
      setFavorites,
      setRecents,
      ...(saveSecret === undefined ? {} : { saveSecret }),
      ...(discardSecret === undefined ? {} : { discardSecret }),
      finish: turn.finish,
      closeLog: () => setLogScreen(undefined),
      closeDiff: () => {
        diffOpenRef.current = false;
        setDiffOpen(false);
      },
      closeSessions: () => setSessionPicker(false),
      closeModels: () => setModelPicker(false),
      closeConfig: () => setConfigOpen(false),
      closeProviders: () => setScreen(undefined),
    },
  );
  if (screenView !== undefined) return screenView;

  // Four TUIX zones (#635): the components only render `renderTimelineZones` lines.
  const timelineStatus = { model: status.model, mode, costUsd: status.costUsd };
  const timelineExpanded: TimelineView["expanded"] = { tools: turn.toolsExpanded, reasoning: turn.reasoningExpanded };
  const liveView = turn.liveTimeline?.view({ kind: "done" }, timelineStatus, timelineExpanded);
  const composerMark = renderTimelineZones({ state: { kind: "done" }, status: timelineStatus }, width).composer[0] ?? "❯";
  const inputLines = input.split("\n");
  return (
    <Box flexDirection="column">
      {turn.liveTimeline === undefined && entries.every((entry) => entry.kind === "info")
        ? <TimelineZone view={{ state: { kind: "empty" }, status: timelineStatus }} width={width} zone="identity" />
        : null}
      {hiddenEntries > 0 ? <Text dimColor>{`… ${hiddenEntries} mensagens anteriores`}</Text> : null}
      <Static items={entries}>
        {(entry, index) => <EntryLine key={index} entry={entry} colors={colors} expanded={timelineExpanded} />}
      </Static>
      {liveView === undefined ? null : <TimelineZone view={liveView} width={width} zone="timeline" />}
      {turn.busy ? (
        // Thinking block (#560): label with the partial stream, collapsible with ctrl+t
        <Box flexDirection="column" borderStyle="round" borderColor={colors.warning} paddingX={1}>
          <Text color={colors.warning}>
            {turn.thinkingCollapsed
              ? "pensando… recolhido (ctrl+t mostra)"
              : "pensando…"}
          </Text>
          {turn.thinkingCollapsed || turn.partial === undefined ? null : <Text>{sanitizeBlockText(turn.partial)}</Text>}
        </Box>
      ) : null}
      {toasts.map((toast) => (
        <Text key={toast.id} color={toast.kind === "error" ? colors.error : toast.kind === "warning" ? colors.warning : colors.accent}>
          {toastLine(toast)}
        </Text>
      ))}
      {turn.queued > 0 ? <Text color={colors.warning}>{`fila: ${turn.queued} na fila (enviada ao fim do turno)`}</Text> : null}
      <Composer
        colors={colors}
        mode={mode}
        {...(question === undefined ? {} : { question })}
        input={input}
        inputLines={inputLines}
        composerMark={composerMark}
        busy={turn.busy}
        suggestions={suggestions}
        selectedIndex={selectedIndex}
        win={win}
      />
      <Text dimColor>
        {footerModel(status.model)}
        {" · "}
        {footerBase({
          place,
          tokensIn: status.tokensIn,
          tokensOut: status.tokensOut,
          costUsd: status.costUsd,
        })}
        {budget === undefined ? null : (
          <Text
            {...(budgetColor(budget, colors) === undefined
              ? { dimColor: true }
              : { color: budgetColor(budget, colors) })}
          >
            {` · ${budgetSegment(budget)}`}
          </Text>
        )}
        {" · modo: "}
        <Text color={modeColor(mode, colors)}>{mode}</Text>
      </Text>
    </Box>
  );
}
