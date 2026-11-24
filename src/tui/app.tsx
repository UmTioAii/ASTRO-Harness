/** TUI (T2): conversa, entrada e status bar. Consome apenas a ChatSession. */
import { Box, Static, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { parseCommand, type ReplCommand } from "../chat/commands";
import { statusLine, type ChatSession } from "../chat/repl";
import { activeSessionRefusal, toSessionRecord } from "../chat/store";
import type { SessionApi, SessionSummary } from "../chat/session-api";
import type { SendTurnOptions, SessionSnapshot } from "../chat/agent-session";
import { isFatalSessionError } from "../chat/session-errors";
import { DEFAULT_PERMISSION_MODE, resolveAstroHome } from "../permissions";
import { isYes } from "../chat/approvers";
import { loadAttachment, loadPastedText } from "../attachments/load";
import { attachmentSizeLabel, materializePrompt } from "../attachments/render";
import { readClipboardText } from "../attachments/clipboard";
import { dedupeKey, type LoadedAttachment } from "../attachments/model";
import { formatApprovalPrompt, type AttachmentApprover } from "../attachments/turn";
import { redactSecrets, sanitizePromptText } from "../sanitize-external";
import { runCommand, type CommandState, type Entry } from "./commands";
import type { ApprovalBridge, ApprovalQuestion } from "./approvals";
import { DiffViewer } from "./diff-viewer";
import type { ShellRunner } from "./shell";
import { COMMANDS, applyCompletion, commandDescription, completionItems, enterAction, suggestionWindow } from "./editor";
import { Header, budgetColor, footerBase, modeColor, packageVersion } from "./banner";
import { appendLog, laneLine, sessionHeaderLine, tailLog } from "./log";
import { LogScreen } from "./log-screen";
import { errorLine } from "./error-hint";
import { indexFiles } from "./files";
import { Markdown } from "./markdown";
import { ModelPicker } from "./model-picker";
import { recordRecent, type ModelOption } from "./models";
import { providerHealth } from "./health";
import { loadTuiConfig, saveTuiConfig, getThemeColors, type Theme, type ThemeColors } from "./theme";
import { LEADER, runKeybind } from "./keybinds";
import { TOAST_TICK_MS, TOAST_TTL_MS, pruneToasts, pushToast, toastLine, type Toast } from "./toasts";
import { ProviderScreen } from "./provider-screen";
import { SessionPicker } from "./session-picker";
import { ConfigScreen } from "./config-screen";
import { loadTrustedStore, trustStatePath } from "../trust";
import { parseConfigEditValue } from "../core/config-edit";
import type { ProfileManager } from "../providers/profile-manager";
import { budgetSegment, quotaSegment } from "../chat/usage";
import { createThrottledSink, STREAM_THROTTLE_MS } from "./stream";
import { HISTORY_LIMIT, visibleWindow } from "./history";
import { renderTimelineZones, sanitizeBlockText, type TimelineTurnStatus, type TimelineView } from "./timeline";
import { TimelineTurnStore } from "./timeline-store";
import { TimelineZone } from "./timeline-zones";

export interface TuiAppProps {
  session: ChatSession;
  cwd: string;
  branch?: string;
  sessionApi?: SessionApi;
  approvals?: ApprovalBridge;
  shell?: ShellRunner;
  manager?: ProfileManager;
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

interface Status {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

const WELCOME = "astro · /help para comandos · /exit para sair";

function statusOf(snapshot: SessionSnapshot): Status {
  return {
    model: snapshot.model,
    tokensIn: snapshot.tokensIn,
    tokensOut: snapshot.tokensOut,
    costUsd: snapshot.costUsd,
  };
}

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function EntryLine({
  entry,
  colors,
  expanded,
}: {
  entry: Entry;
  colors: ThemeColors;
  expanded?: TimelineView["expanded"];
}): ReactElement {
  const { columns } = useWindowSize();
  const width = columns !== undefined && columns > 0 ? columns : 80;
  if (entry.kind === "timeline" && entry.timeline !== undefined) {
    const view = {
      state: { kind: "done" as const },
      status: { model: "", mode: "" },
      turn: entry.timeline,
      ...(entry.results === undefined ? {} : { results: entry.results }),
      ...(expanded === undefined ? {} : { expanded }),
    };
    return <TimelineZone view={view} width={width} zone="timeline" />;
  }
  if (entry.kind === "user") return <Text color={colors.accent}>{"> "}{entry.text}</Text>;
  if (entry.kind === "assistant") return <Markdown text={entry.text} />;
  if (entry.kind === "error") return <Text color={colors.error}>{entry.text}</Text>;
  if (entry.kind === "shell") {
    // Bloco shell (#560): cabeçalho com comando/cwd/exit e corpo com a saída.
    const meta = entry.shell;
    const tone = meta?.isError === true ? colors.error : colors.accent;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
        <Text color={tone}>
          {"$ "}{meta?.command ?? entry.text}
          {meta === undefined ? null : <Text dimColor>{`  ·  cwd: ${meta.cwd} · exit: ${meta.exitLabel}`}</Text>}
        </Text>
        <Text color={meta?.isError === true ? colors.error : undefined}>{entry.text}</Text>
      </Box>
    );
  }
  return <Text dimColor>{entry.text}</Text>;
}

/** Persiste o último modelo sem derrubar a ativação se o arquivo falhar. */
export function persistLastModel(cwd: string, model: string, onWarning?: (message: string) => void): void {
  try {
    saveTuiConfig(cwd, { lastModel: model });
  } catch {
    const message = "aviso: não foi possível salvar o último modelo da TUI";
    if (onWarning === undefined) console.error(message);
    else onWarning(message);
  }
}

/** Ativa o provider na sessão e persiste o último modelo, sem falhar a ativação. */
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

export function TuiApp({ session, cwd, branch, sessionApi, approvals, shell, manager, onExit, toastTtlMs = TOAST_TTL_MS, streamThrottleMs = STREAM_THROTTLE_MS, historyLimit = HISTORY_LIMIT, saveSecret, discardSecret, onTimelineEntry }: TuiAppProps): ReactElement {
  const { columns } = useWindowSize();
  const width = columns !== undefined && columns > 0 ? columns : 80;
  const [entries, setEntries] = useState<Entry[]>([{ kind: "info", text: WELCOME }]);
  /** Estado da sessão aparece uma vez por sessão (#480): só entradas marcadas. */
  const appendEntries = (added: Entry[]): void => {
    setEntries((current) => {
      const seen = new Set(current.filter((entry) => entry.state === true).map((entry) => entry.text));
      const fresh = added.filter((entry) => entry.state !== true || !seen.has(entry.text));
      return fresh.length === 0 ? current : [...current, ...fresh];
    });
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
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<string | undefined>(undefined);
  /** Fila de mensagens digitadas durante o turno (#560): enviadas ao fim do turno. */
  const queueRef = useRef<string[]>([]);
  const [queued, setQueued] = useState(0);
  /** Bloco thinking recolhido com ctrl+t durante o stream (#560). */
  const [thinkingCollapsed, setThinkingCollapsed] = useState(false);
  /** Tool output is collapsed by default (ADR-0035); ctrl+o reveals it. */
  const [toolsExpanded, setToolsExpanded] = useState(false);
  /** Reasoning is collapsed by default (ADR-0035); ctrl+t reveals it when emitted. */
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const [initialConfig] = useState(() => loadTuiConfig(cwd));
  const [theme, setTheme] = useState<Theme>(initialConfig.theme);
  const colors = getThemeColors(theme);
  const persistTheme = (next: Theme): void => {
    // persiste antes de aplicar: falha de escrita não deixa a TUI num tema que não sobrevive ao restart
    saveTuiConfig(cwd, { theme: next });
    setTheme(next);
  };
  const leader = useRef(false);
  const busyRef = useRef(false);
  const turn = useRef<AbortController | undefined>(undefined);
  /** Current turn's live timeline (#635); history entries keep completed turns. */
  const liveTimeline = useRef<TimelineTurnStore | undefined>(undefined);
  /** First message of the live turn: ctrl+o reads bodies from here only. */
  const liveMessagesFrom = useRef(0);
  const [, setTimelineTick] = useState(0);
  const refreshTimeline = (): void => setTimelineTick((tick) => tick + 1);
  /** ctrl+o syncs the live bodies before expanding, so output exists while the turn still runs. */
  const toggleToolOutput = (): void => {
    const live = liveTimeline.current;
    if (live !== undefined) {
      live.setResultsFromMessages(session.snapshot().messages.slice(liveMessagesFrom.current));
      refreshTimeline();
    }
    setToolsExpanded((current) => !current);
  };
  const exitRequested = useRef(false);
  const [status, setStatus] = useState<Status>(() => statusOf(session.snapshot()));
  const [health, setHealth] = useState<{ provider: string; state: "ok" | "down" } | undefined>(undefined);
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
      setHealth(state === undefined ? undefined : { provider, state });
      // Só transições de saúde vão para o /log (#514, docs/tui-layout.md §/log)
      if (state !== undefined) {
        const line = laneLine("saúde", `saúde: ${provider} ${state}`); // lane separada (#560)
        if (lastHealthLogRef.current !== line) {
          lastHealthLogRef.current = line;
          logLine(line);
        }
      }
    } catch {
      if (token === healthToken.current) setHealth(undefined);
    }
  };
  const [screen, setScreen] = useState<{ mode: "list" | "add" | "edit" | "remove"; target?: string } | undefined>(undefined);
  const [logScreen, setLogScreen] = useState<{ n?: number } | undefined>(undefined); // tela `/log` (#514)
  const [configOpen, setConfigOpen] = useState(false); // tela `/config` (#273)
  const [modelPicker, setModelPicker] = useState(false);
  const [sessionPicker, setSessionPicker] = useState(false); // modal `/sessions` (#64)
  const [diffOpen, setDiffOpen] = useState(false); // overlay de diff da aprovação (#64 D2)
  const diffOpenRef = useRef(false);
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [favorites, setFavorites] = useState<string[]>(initialConfig.favoriteModels ?? []);
  const [recents, setRecents] = useState<string[]>(initialConfig.recentModels ?? []);
  const commandState = useRef<CommandState>({});
  // Buffer de log da sessão em memória (#514): ring em ref, nunca persiste (audit/ledger são a fonte durável)
  const logRef = useRef<string[]>([]);
  const lastLogHeaderRef = useRef<string | undefined>(undefined);
  const lastHealthLogRef = useRef<string | undefined>(undefined); // só transições de saúde vão para o /log (#514)
  const contextInlineRef = useRef(false); // 1ª ocorrência do aviso de contexto fica só inline (#514)
  const logLine = (line: string): void => {
    logRef.current = appendLog(logRef.current, line);
  };
  const endpointOf = (): string =>
    manager?.list().find((item) => item.id === activeProvider())?.baseUrl ?? "-";
  /** Cabeçalho da sessão vai para o /log (versão, provider/modelo, endpoint); só grava quando muda. */
  const logSessionHeader = (): void => {
    const header = sessionHeaderLine({ version: packageVersion(), model: session.snapshot().model, endpoint: endpointOf() });
    if (lastLogHeaderRef.current === header) return;
    lastLogHeaderRef.current = header;
    logLine(laneLine("sessão", header)); // lane separada no /log (#560)
  };
  const pendingAttachments = useRef<LoadedAttachment[]>([]);
  const exited = useRef(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = (toast: { kind: Toast["kind"]; text: string }): void => {
    setToasts((current) => pushToast(current, toast, Date.now()));
  };
  // Virtualização do histórico (#64): o <Static> do ink é append-only por
  // contagem (items.slice(index)), então o corte da janela acontece num update
  // separado (efeito abaixo), nunca atomicamente com o append — senão itens na
  // borda seriam pulados. As ocultas viram marcador acima do <Static>.
  const [hiddenEntries, setHiddenEntries] = useState(0);
  useEffect(() => {
    if (entries.length <= historyLimit) return;
    setHiddenEntries((hidden) => hidden + (entries.length - historyLimit));
    setEntries((current) => visibleWindow(current, historyLimit));
  }, [entries.length, historyLimit]);

  // Toasts ficam para confirmações transitórias (copiar/exportar). Erro é linha
  // inline com próximo passo; nada de toast duplicando o histórico (#480).

  // Remove os toasts expirados; só roda o tick quando há algo na tela
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
        // resposta dada ou pergunta nova sem diff: o overlay não fica aberto
        // (alinha o guarda do useInput com a condição de render do overlay)
        diffOpenRef.current = false;
        setDiffOpen(false);
      }
    });
  }, [approvals]);

  useEffect(() => {
    setFiles(indexFiles(cwd));
  }, [cwd]);

  // Cabeçalho da sessão entra no buffer de /log ao abrir (#514)
  useEffect(() => {
    logSessionHeader();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roda só no mount
  }, []);

  const persist = (report: boolean): { path?: string; failed: boolean } => {
    if (sessionApi === undefined) return { failed: false };
    try {
      sessionApi.save(toSessionRecord(session.snapshot()));
      return { path: sessionApi.databasePath, failed: false };
    } catch (error) {
      if (report) setEntries((current) => [...current, { kind: "error", text: errorLine(error, messageOf(error)) }]);
      return { failed: true };
    }
  };

  const finish = (): void => {
    if (exited.current) return;
    if (busyRef.current) {
      if (exitRequested.current) {
        // segundo pedido: desmonta mesmo sem o provider responder
        exited.current = true;
        persist(false);
        onExit?.();
        return;
      }
      exitRequested.current = true;
      turn.current?.abort();
      return;
    }
    exited.current = true;
    persist(false);
    onExit?.();
  };

  const pickerModels = (): ModelOption[] => {
    const info = session.listModelInfo?.();
    if (info !== undefined) return info;
    return session.listModels().map((ref) => {
      const slash = ref.indexOf("/");
      const provider = slash < 0 ? ref : ref.slice(0, slash);
      const id = slash < 0 ? ref : ref.slice(slash + 1);
      return { ref, provider, id, tags: [], status: "unknown" };
    });
  };

  const listPending = (): string =>
    pendingAttachments.current.length === 0
      ? "nenhum anexo pendente"
      : pendingAttachments.current
          .map((attachment, index) => `${index + 1}. ${attachment.name} (${attachmentSizeLabel(attachment)})`)
          .join("\n");

  /** Aprovação do lote de imagens na linha da TUI; sem a ponte de aprovação, nega (fail closed). */
  const approveAttachment: AttachmentApprover = async (items) =>
    approvals !== undefined && isYes(await approvals.askText(`${formatApprovalPrompt(items)}\naprovar envio? (s/n)`));

  const duplicateMessage = (attachment: LoadedAttachment): string | undefined => {
    const existing = pendingAttachments.current.find((item) => dedupeKey(item) === dedupeKey(attachment));
    return existing === undefined ? undefined : `erro: anexo já adicionado: ${existing.name} (o mesmo anexo já está pendente)`;
  };

  const handleAttachmentCommand = async (command: ReplCommand): Promise<void> => {
    if (command.kind === "attach") {
      if (command.path === undefined) {
        setEntries((current) => [...current, { kind: "info", text: listPending() }]);
        return;
      }
      try {
        const loaded = await loadAttachment({
          path: command.path,
          ...(command.range === undefined ? {} : { range: command.range }),
          cwd,
          astroHome: resolveAstroHome(),
          showHidden: session.attachmentsShowHidden?.() === true,
          ...(session.attachmentProtectedPaths === undefined ? {} : { protectedPaths: session.attachmentProtectedPaths() }),
          confirmOutsideCwd: async (absolute) =>
            approvals === undefined
              ? false
              : isYes(await approvals.askText(`anexo fora do cwd: ${absolute} — aprovar? (s/n)`)),
        });
        const duplicate = duplicateMessage(loaded);
        if (duplicate !== undefined) {
          setEntries((current) => [...current, { kind: "error", text: duplicate }]);
          return;
        }
        pendingAttachments.current.push(loaded);
        setEntries((current) => [
          ...current,
          { kind: "info", text: `anexo adicionado: ${command.path}\n${listPending()}` },
        ]);
      } catch (error) {
        setEntries((current) => [...current, { kind: "error", text: errorLine(error, messageOf(error)) }]);
      }
      return;
    }
    if (command.kind === "paste") {
      try {
        const pasted = loadPastedText(readClipboardText());
        const duplicate = duplicateMessage(pasted);
        if (duplicate !== undefined) {
          setEntries((current) => [...current, { kind: "error", text: duplicate }]);
          return;
        }
        pendingAttachments.current.push(pasted);
        setEntries((current) => [
          ...current,
          { kind: "info", text: `anexo adicionado: clipboard\n${listPending()}` },
        ]);
      } catch (error) {
        setEntries((current) => [...current, { kind: "error", text: errorLine(error, messageOf(error)) }]);
      }
      return;
    }
    if (command.kind === "detach") {
      if (command.target === undefined) {
        setEntries((current) => [...current, { kind: "info", text: listPending() }]);
        return;
      }
      if (command.target === "all") {
        pendingAttachments.current = [];
        setEntries((current) => [...current, { kind: "info", text: "anexos removidos" }]);
        return;
      }
      const index = Number(command.target);
      if (!Number.isInteger(index) || index < 1 || index > pendingAttachments.current.length) {
        setEntries((current) => [...current, { kind: "error", text: `anexo inválido: ${command.target}` }]);
        return;
      }
      pendingAttachments.current.splice(index - 1, 1);
      setEntries((current) => [...current, { kind: "info", text: listPending() }]);
    }
  };

  /** Envia `raw` (já sem o clear do editor); usado pelo Enter e pelo dreno da fila (#560). */
  const submitText = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (text === "") return;
    if (text.startsWith("!")) {
      const command = text.slice(1);
      setEntries((current) => [...current, { kind: "user", text }]);
      if (shell === undefined) {
        setEntries((current) => [...current, { kind: "error", text: "shell indisponível" }]);
        return;
      }
      busyRef.current = true;
      const shellTurn = new AbortController();
      turn.current = shellTurn;
      setBusy(true);
      try {
        const result = await shell.run(command, shellTurn.signal);
        // Bloco shell (#560): comando/cwd/exit no cabeçalho, saída no corpo.
        setEntries((current) => [
          ...current,
          {
            kind: "shell" as const,
            text: result.output,
            shell: { command, cwd, exitLabel: result.isError ? "erro" : "0", isError: result.isError },
          },
        ]);
      } finally {
        busyRef.current = false;
        turn.current = undefined;
        setBusy(false);
        if (exitRequested.current) finish();
      }
      return;
    }
    // Texto com quebra de linha nunca é comando de barra: parseCommand separa
    // em \n e executaria o comando descartando o resto silenciosamente (#63)
    const command: ReplCommand = text.includes("\n") ? { kind: "prompt", text } : parseCommand(text);
    if (command.kind === "empty") return;
    if (command.kind === "exit") {
      finish();
      return;
    }
    if (command.kind === "attach" || command.kind === "paste" || command.kind === "detach") {
      await handleAttachmentCommand(command);
      return;
    }
    if (command.kind === "model" && command.model === undefined) {
      setModelPicker(true);
      return;
    }
    if (command.kind !== "prompt") {
      // `/theme` precisa do tema vivo e do aplicador que persiste o estado da TUI em `$ASTRO_HOME` (#64, #468)
      commandState.current.theme = theme;
      commandState.current.setTheme = persistTheme;
      const outcome = await runCommand(command, session, commandState.current, { cwd, sessionApi });
      if (outcome.openLog !== undefined) {
        // /log abre a tela com o buffer; null = tudo, n = últimas n linhas (#514)
        setLogScreen(outcome.openLog === null ? {} : { n: outcome.openLog });
        return;
      }
      if (outcome.openProviders !== undefined) {
        if (manager === undefined) {
          setEntries((current) => [...current, { kind: "error", text: "tela de providers indisponível" }]);
          return;
        }
        setEntries((current) => [...current, ...outcome.entries]);
        setScreen(outcome.openProviders);
        return;
      }
      if (outcome.openConfig === true) {
        if (session.configSummary === undefined) {
          setEntries((current) => [...current, { kind: "error", text: "tela de configuração indisponível nesta sessão" }]);
          return;
        }
        setConfigOpen(true);
        return;
      }
      if (outcome.openSessions === true) {
        try {
          setSessionList(sessionApi?.list() ?? []);
          setSessionPicker(true);
        } catch (error) {
          setEntries((current) => [...current, { kind: "error", text: errorLine(error, messageOf(error)) }]);
        }
        return;
      }
      if (outcome.lastFile !== undefined) commandState.current.lastFile = outcome.lastFile ?? undefined;
      const added = [...outcome.entries];
      const modelChanged = (command.kind === "model" && command.model !== undefined)
        || (command.kind === "provider" && command.action === "use" && command.target !== undefined)
        || (command.kind === "resume" && command.ref !== undefined && !outcome.entries.some((entry) => entry.kind === "error"));
      if (modelChanged) {
        try {
          saveTuiConfig(cwd, { lastModel: session.snapshot().model });
        } catch (error) {
          added.push({ kind: "error", text: errorLine(error, messageOf(error)) });
        }
        logSessionHeader(); // novo cabeçalho da sessão vai para o /log (#514)
        if (command.kind === "provider" && command.action === "use") void refreshHealth();
      }
      // Só estado da sessão deduplica (#480): /help, /usage e /save repetem.
      const stateful = command.kind === "model" || command.kind === "provider"
        || command.kind === "resume" || command.kind === "theme" || command.kind === "mode";
      appendEntries(stateful ? added.map((entry) => (entry.kind === "info" ? { ...entry, state: true } : entry)) : added);
      setStatus(statusOf(session.snapshot()));
      if (outcome.exit) finish();
      return;
    }
    const messagesBefore = session.snapshot().messages.length;
    liveMessagesFrom.current = messagesBefore;
    const timeline = new TimelineTurnStore(`turn-${Date.now()}`, text);
    liveTimeline.current = timeline;
    refreshTimeline();
    busyRef.current = true;
    const controller = new AbortController();
    turn.current = controller;
    setBusy(true);
    // deltas do provider passam pelo throttle: leading edge + trailing (#64)
    const sink = createThrottledSink({
      intervalMs: streamThrottleMs,
      now: () => Date.now(),
      schedule: (cb, ms) => { setTimeout(cb, ms); },
      emit: (text) => setPartial((current) => (current ?? "") + text),
    });
    /** Commits the live turn to history with every tool body available at that point. */
    const commitTimeline = (status: TimelineTurnStatus): Entry => {
      timeline.setResultsFromMessages(session.snapshot().messages.slice(messagesBefore));
      timeline.complete(status);
      liveTimeline.current = undefined;
      refreshTimeline();
      const entry: Entry = { kind: "timeline", text: "", timeline: timeline.turn, results: timeline.results };
      onTimelineEntry?.(entry);
      return entry;
    };
    try {
      const prompt = materializePrompt(command.text, pendingAttachments.current);
      const attachments = pendingAttachments.current;
      const turnOptions: SendTurnOptions = {
        // Live timeline (#635): the observer only updates rendered state.
        observer: (event) => { if (timeline.apply(event)) refreshTimeline(); },
        ...(attachments.length === 0 ? {} : { attachments, approveAttachment }),
      };
      const result = await session.send(
        prompt,
        controller.signal,
        (delta) => sink.add(delta),
        undefined,
        turnOptions,
      );
      pendingAttachments.current = [];
      sink.flush();
      setPartial(undefined);
      // Resumo do turno sai da conversa e vai para o /log (#514, docs/tui-layout.md), lane [turno] (#560)
      logLine(laneLine("turno", "turno concluído"));
      logLine(laneLine("turno", statusLine(result)));
      const contextNote = result.warning ? `⚠ contexto ${Math.round(result.contextRatio * 100)}% (≥80%)` : undefined;
      if (contextNote !== undefined) {
        // 1ª ocorrência fica só inline; repetições vão para o /log (#514, doc §/log), lane [aviso] (#560)
        if (contextInlineRef.current) logLine(laneLine("aviso", contextNote));
        else contextInlineRef.current = true;
      }
      const timelineEntry = commitTimeline("done");
      appendEntries([
        timelineEntry,
        { kind: "assistant", text: sanitizeBlockText(result.final) },
        // Aviso que muda a resposta fica inline uma vez; repetição é estado (#480).
        ...(contextNote === undefined ? [] : [{ kind: "info" as const, state: true, text: contextNote }]),
        ...(result.trimmed ? [{ kind: "info" as const, state: true, text: "turno antigo descartado" }] : []),
      ]);
    } catch (error) {
      const timelineEntry = commitTimeline(timeline.status === "running" ? "failed" : timeline.status);
      appendEntries([
        timelineEntry,
        { kind: "error", text: errorLine(error, messageOf(error)) },
      ]);
      if (isFatalSessionError(error)) exitRequested.current = true;
    } finally {
      if (liveTimeline.current === timeline) {
        appendEntries([commitTimeline(timeline.status === "running" ? "failed" : timeline.status)]);
      }
      sink.flush(); // invalida timer pendente: nenhum delta emite depois do turno
      setPartial(undefined);
      const saved = persist(true);
      if (saved.failed) commandState.current.lastFile = undefined;
      else if (saved.path !== undefined) commandState.current.lastFile = saved.path;
      setStatus(statusOf(session.snapshot()));
      busyRef.current = false;
      turn.current = undefined;
      setBusy(false);
      if (exitRequested.current) finish();
    }
  };

  /** Envia a próxima mensagem da fila, se houver (#560). */
  const drainQueue = (): void => {
    const next = queueRef.current.shift();
    setQueued(queueRef.current.length);
    if (next !== undefined) void dispatch(next);
  };

  /**
   * Envia `raw` e, quando a submissão não abre turno (comando de barra), drena o
   * resto da fila (#560). Turnos longos drenam no próprio `finally` do turno.
   */
  const dispatch = async (raw: string): Promise<void> => {
    try {
      await submitText(raw);
    } finally {
      if (!exited.current && !exitRequested.current && !busyRef.current) drainQueue();
    }
  };

  /** Enter no editor: limpa a linha e envia; durante o turno vai para a fila (#560). */
  const submit = (): void => {
    const text = inputRef.current.trim();
    if (text === "") return;
    setInput(() => "");
    void dispatch(text);
  };

  useInput((value, key) => {    if (screen !== undefined || modelPicker || configOpen || sessionPicker || diffOpen || logScreen !== undefined) return; const ctrl = key.ctrl === true;
    if (ctrl && (value === "c" || value === "d")) {
      approvals?.answer("");
      finish();
      return;
    }
    if (question !== undefined) {
      if (key.tab && question.diff !== undefined && !diffOpenRef.current) {
        // tab abre o overlay de diff da tool edit sem engolir a linha de resposta (#64 D2)
        diffOpenRef.current = true;
        setDiffOpen(true);
        return;
      }
      if (key.return) {
        const answer = inputRef.current;
        setInput(() => "");
        approvals?.answer(answer);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((current) => current.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && !key.escape) {
        const clean = value.replace(/[\r\n]/g, "");
        if (clean !== "") setInput((current) => current + clean);
      }
      return;
    }
    // #560: o editor continua editável durante o turno; Enter enfileira a mensagem.
    const streaming = busy || busyRef.current;
    if (streaming) leader.current = false; // leader não vale durante o stream
    if (ctrl && value === "o") {
      // ctrl+o expands the tool bodies, redacted and keyed by callId (#635)
      toggleToolOutput();
      return;
    }
    if (ctrl && value === "t") {
      // ctrl+t collapses the thinking block and reveals the reasoning timeline (#600).
      setThinkingCollapsed((current) => !current);
      setReasoningExpanded((current) => !current);
      return;
    }
    if (!streaming && leader.current) {
      leader.current = false;
      runKeybind(`${LEADER} ${value.toLowerCase()}`, {
        session,
        ...(sessionApi === undefined ? {} : { sessionApi }),
        theme,
        addEntries: (added) => appendEntries(added),
        setTheme: persistTheme,
        finish,
      });
      return;
    }
    if (!streaming && ctrl && value === "x") {
      leader.current = true;
      return;
    }
    if (suggestions.length > 0) {
      if (key.tab) {
        setInput(() => applyCompletion(inputRef.current, suggestions[selectedIndex]!));
        setSelected(0);
        return;
      }
      if (key.upArrow) {
        setSelected((selectedIndex - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow) {
        setSelected((selectedIndex + 1) % suggestions.length);
        return;
      }
    }
    if (key.return && key.shift) {
      // shift+enter (protocolo kitty, CSI 13;2u): quebra linha no editor (#63)
      setInput((current) => `${current}\n`);
      setSelected(0);
      return;
    }
    if (value === "\n") {
      // linefeed legado (shift+enter em terminal sem kitty) também quebra linha (#63)
      setInput((current) => `${current}\n`);
      setSelected(0);
      return;
    }
    if (key.return) {
      const suggestion = suggestions.length > 0 ? suggestions[selectedIndex] : undefined;
      if (suggestion !== undefined && enterAction(inputRef.current, suggestion) === "apply-completion") {
        // #471: 1º Enter aplica a completion na linha; o próximo Enter confirma e roda
        setInput(() => applyCompletion(inputRef.current, suggestion));
        setSelected(0);
        return;
      }
      if (streaming) {
        // #560: durante o turno a mensagem vai para a fila, enviada no fim do turno
        const text = inputRef.current.trim();
        if (text !== "") {
          queueRef.current.push(text);
          setQueued(queueRef.current.length);
        }
        setInput(() => "");
        return;
      }
      submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      setSelected(0);
      return;
    }
    if (!key.ctrl && !key.meta && !key.escape) {
      const clean = value.replace(/[\r\n]/g, "");
      if (clean !== "") {
        const before = inputRef.current;
        setInput((current) => current + clean);
        setSelected(0);
        if (!before.includes("@") && `${before}${clean}`.includes("@")) setFiles(indexFiles(cwd));
      }
    }
  });

  // Segmento de budget na status bar (#63): hook antes dos returns condicionais abaixo;
  // recalcula quando o status da sessão muda; falha de leitura vira "sem segmento"
  const budget = useMemo(() => {
    try {
      return session.budgetStatus?.();
    } catch {
      return undefined;
    }
  }, [session, status]);

  // Aviso de custo alto (#64): toast na transição para aviso/esgotado/teto do budget
  const budgetAlarm = useRef(false);
  useEffect(() => {
    const high = budget !== undefined && (budget.warning || budget.exhausted || budget.ceilingHit);
    if (high && budget !== undefined) {
      // 1ª faixa de aviso sai só no toast (transitório); repetições vão para o /log (#514, #64, doc §/log)
      if (budgetAlarm.current) logLine(`custo alto · ${budgetSegment(budget)}`);
      else addToast({ kind: "warning", text: `custo alto · ${budgetSegment(budget)}` });
    }
    budgetAlarm.current = high;
  }, [budget]);

  // Aviso de quota do domínio ativo (#64, F6-3): mesmo padrão do budget, mas
  // com tokens do dia/custo do mês em vez de USD do budget
  const quota = useMemo(() => {
    try {
      return session.quotaStatus?.();
    } catch {
      return undefined;
    }
  }, [session, status]);
  const quotaAlarm = useRef(false);
  useEffect(() => {
    const high = quota !== undefined && (quota.warning || quota.exhausted);
    if (high && quota !== undefined) {
      // mesma regra do budget: 1ª vez só no toast, repetições no /log (#514, doc §/log)
      if (quotaAlarm.current) logLine(quotaSegment(quota));
      else addToast({ kind: "warning", text: quotaSegment(quota) });
    }
    quotaAlarm.current = high;
  }, [quota]);

  if (logScreen !== undefined) {
    // Tela /log (#514): cabeçalho da sessão com endpoint + buffer em memória (tail n)
    return (
      <LogScreen
        colors={colors}
        header={sessionHeaderLine({ version: packageVersion(), model: status.model, endpoint: endpointOf() })}
        lines={tailLog(logRef.current, logScreen.n)}
        onClose={() => setLogScreen(undefined)}
      />
    );
  }

  if (diffOpen && question?.diff !== undefined) {
    return (
      <DiffViewer
        path={question.diff.path}
        diff={question.diff.content}
        colors={colors}
        onClose={() => {
          diffOpenRef.current = false;
          setDiffOpen(false);
        }}
      />
    );
  }

  if (sessionPicker) {
    return (
      <SessionPicker
        sessions={sessionList}
        colors={colors}
        onClose={() => setSessionPicker(false)}
        onExit={finish}
        onResume={(chosen) => {
          void (async () => {
            const outcome = await runCommand(
              { kind: "resume", ref: chosen.id }, session, commandState.current,
              { cwd, sessionApi, resumeId: chosen.id },
            );
            if (outcome.lastFile !== undefined) commandState.current.lastFile = outcome.lastFile ?? undefined;
            const added = [...outcome.entries];
            const failed = added.some((entry) => entry.kind === "error");
            if (!failed) {
              try {
                saveTuiConfig(cwd, { lastModel: session.snapshot().model });
              } catch (error) {
                added.push({ kind: "error", text: errorLine(error, messageOf(error)) });
              }
            }
            appendEntries(added);
            setStatus(statusOf(session.snapshot()));
            setSessionPicker(false);
          })().catch((error: unknown) => {
            setEntries((current) => [...current, { kind: "error", text: errorLine(error, messageOf(error)) }]);
            setSessionPicker(false);
          });
        }}
        onRename={(chosen, name) => {
          if (sessionApi === undefined) return "sem persistência configurada";
          try {
            sessionApi.rename(chosen.id, name);
            setSessionList(sessionApi.list());
            return undefined;
          } catch (error) {
            return `erro: ${messageOf(error)}`;
          }
        }}
        onDelete={(chosen) => {
          if (sessionApi === undefined) return "sem persistência configurada";
          // a sessão atual segue no auto-save; a origem retomada segue na linhagem da conversa (#366)
          const refusal = activeSessionRefusal(session.snapshot(), chosen.id);
          if (refusal !== undefined) return refusal;
          try {
            const deleted = sessionApi.delete(chosen.id);
            setSessionList(sessionApi.list());
            return deleted ? undefined : "sessão não encontrada";
          } catch (error) {
            return `erro: ${messageOf(error)}`;
          }
        }}
      />
    );
  }

  /** Troca o modelo da sessão e persiste (picker e /provider compartilham, #555). */
  const selectModel = (ref: string): void => {
    try {
      const model = session.setModel(ref);
      const nextRecents = recordRecent(model, recents);
      try {
        saveTuiConfig(cwd, { lastModel: model, recentModels: nextRecents });
      } catch (error) {
        setEntries((current) => [...current, { kind: "error", text: errorLine(error, messageOf(error)) }]);
      }
      setRecents(nextRecents);
      setStatus(statusOf(session.snapshot()));
      setEntries((current) => [...current, { kind: "info", text: `modelo: ${model}` }]);
      logSessionHeader(); // novo cabeçalho da sessão vai para o /log (#514)
    } catch (error) {
      setEntries((current) => [...current, { kind: "error", text: errorLine(error, messageOf(error)) }]);
    }
  };

  if (modelPicker) {
    return (
      <ModelPicker
        models={pickerModels()}
        favorites={favorites}
        recents={recents}
        colors={colors}
        onClose={() => setModelPicker(false)}
        onExit={finish}
        onSelect={(ref) => {
          selectModel(ref);
          setModelPicker(false);
        }}
        onFavorite={(next) => {
          try {
            saveTuiConfig(cwd, { favoriteModels: next });
            setFavorites(next);
          } catch (error) {
            setEntries((current) => [...current, { kind: "error", text: errorLine(error, messageOf(error)) }]);
          }
        }}
      />
    );
  }

  if (configOpen) {
    const summary = session.configSummary?.();
    if (summary === undefined) {
      return <Text color={colors.error}>tela de configuração indisponível nesta sessão</Text>;
    }
    let trusted: readonly string[] = [];
    try {
      // mesma fonte que a revogação usa (env da sessão), não o process.env da UI (#267)
      trusted = session.trustedFolders?.() ?? loadTrustedStore(trustStatePath()).folders;
    } catch {
      trusted = []; // store de trust inválido não impede ver a config
    }
    return (
      <ConfigScreen
        colors={colors}
        summary={summary}
        trustedFolders={trusted}
        onClose={() => setConfigOpen(false)}
        onSaveMode={(mode) => {
          if (session.savePermissionMode === undefined) throw new Error("esta sessão não aceita trocar o modo");
          session.savePermissionMode(mode); // persiste na config + troca em runtime (#273)
          setEntries((current) => [...current, { kind: "info", text: `modo: ${mode} (salvo na config)` }]);
        }}
        onRevokeTrust={(dir) => {
          if (session.revokeTrustedFolder === undefined) throw new Error("esta sessão não aceita revogar trust");
          const removed = session.revokeTrustedFolder(dir); // remove do store global + audita (#267)
          if (removed) setEntries((current) => [...current, { kind: "info", text: `trust revogado: ${dir}` }]);
          return removed;
        }}
        onSaveKnob={(key, rawValue) => {
          // valida o valor, grava no arquivo e recarrega na sessão (#558)
          if (session.applyConfigEdits === undefined) throw new Error("esta sessão não aceita editar a config");
          parseConfigEditValue(key, rawValue); // parse primeiro: erro aqui não grava nada
          session.applyConfigEdits({ [key]: rawValue });
          setEntries((current) => [...current, { kind: "info", text: `salvo: ${key} = ${rawValue} (gravado na config)` }]);
        }}
      />
    );
  }

  if (screen !== undefined && manager !== undefined) {
    return (
      <ProviderScreen
        manager={manager}
        colors={colors}
        currentModel={session.model}
        initial={screen}
        modelInfo={pickerModels()}
        onSelectModel={selectModel}
        onClose={() => setScreen(undefined)}
        onActivate={(id) => {
          activateProvider(session, cwd, id, (text) => {
            setEntries((current) => [...current, { kind: "error", text }]);
          });
          setStatus(statusOf(session.snapshot()));
          setEntries((current) => [...current, { kind: "info", text: `provider: ${session.model}` }]);
          logSessionHeader(); // novo cabeçalho da sessão vai para o /log (#514)
          void refreshHealth();
        }}
        onChanged={() => {
          try {
            session.reload?.();
            healthToken.current++;
            setHealth(undefined);
            setStatus(statusOf(session.snapshot()));
          } catch (error) {
            setEntries((current) => [...current, { kind: "error", text: errorLine(error, messageOf(error)) }]);
          }
        }}
        {...(session.probeProvider === undefined ? {} : { onTest: async (id: string) => {
          const token = ++healthToken.current;
          const check = await session.probeProvider!(id);
          if (token !== healthToken.current) return check;
          if (id === activeProvider()) {
            const state = providerHealth({ status: check.status === "ok" ? "ok" : "down", checks: [check] }, id);
            setHealth(state === undefined ? undefined : { provider: id, state });
          }
          return check;
        } })}
        {...(session.loginCodex === undefined ? {} : { onLogin: (id: string, signal?: AbortSignal) => session.loginCodex!(id, signal) })}
        {...(saveSecret === undefined ? {} : { onSaveSecret: saveSecret })}
        {...(discardSecret === undefined ? {} : { onDiscardSecret: discardSecret })}
      />
    );
  }

  const place = branch === undefined ? cwd : `${cwd} (${branch})`;
  const suggestions = question === undefined ? completionItems(input, COMMANDS, files) : [];
  const selectedIndex = suggestions.length === 0 ? 0 : Math.min(selected, suggestions.length - 1);
  const win = suggestionWindow(suggestions.length, selectedIndex);
  const visibleSuggestions = suggestions.slice(win.start, win.end);
  const providerId = session.providerName?.() ?? status.model.split("/")[0]!;
  const healthState = health?.provider === providerId ? health.state : "n/d";
  const inputLines = input.split("\n");
  // Modo de permissão sempre visível (#270); bypass em cor de alerta
  const mode = session.permissionMode?.() ?? DEFAULT_PERMISSION_MODE;
  // Four TUIX zones (#635): the components only render `renderTimelineZones` lines.
  const timelineStatus = { model: status.model, mode, costUsd: status.costUsd };
  const timelineExpanded = { tools: toolsExpanded, reasoning: reasoningExpanded };
  const liveView = liveTimeline.current?.view({ kind: "done" }, timelineStatus, timelineExpanded);
  const composerMark = renderTimelineZones({ state: { kind: "done" }, status: timelineStatus }, width).composer[0] ?? "❯";
  return (
    <Box flexDirection="column">
      <Header colors={colors} provider={providerId} model={status.model} health={healthState} />
      {liveTimeline.current === undefined && entries.every((entry) => entry.kind === "info")
        ? <TimelineZone view={{ state: { kind: "empty" }, status: timelineStatus }} width={width} zone="identity" />
        : null}
      {hiddenEntries > 0 ? <Text dimColor>{`… ${hiddenEntries} mensagens anteriores`}</Text> : null}
      <Static items={entries}>
        {(entry, index) => <EntryLine key={index} entry={entry} colors={colors} expanded={timelineExpanded} />}
      </Static>
      {liveView === undefined ? null : <TimelineZone view={liveView} width={width} zone="timeline" />}
      {busy ? (
        // Bloco thinking (#560): rótulo com passo + stream parcial, recolhível com ctrl+t
        <Box flexDirection="column" borderStyle="round" borderColor={colors.warning} paddingX={1}>
          <Text color={colors.warning}>
            {thinkingCollapsed
              ? "pensando… recolhido (ctrl+t mostra)"
              : "pensando…"}
          </Text>
          {thinkingCollapsed || partial === undefined ? null : <Text>{sanitizeBlockText(partial)}</Text>}
        </Box>
      ) : null}
      {toasts.map((toast) => (
        <Text key={toast.id} color={toast.kind === "error" ? colors.error : toast.kind === "warning" ? colors.warning : colors.accent}>
          {toastLine(toast)}
        </Text>
      ))}
      {queued > 0 ? <Text color={colors.warning}>{`fila: ${queued} na fila (enviada ao fim do turno)`}</Text> : null}
      <Box
        marginTop={1}
        borderStyle="round"
        borderColor={question !== undefined ? colors.warning : mode === "bypass" ? colors.error : colors.accent}
        paddingX={1}
        flexDirection="column"
      >
        {question === undefined
          ? inputLines.map((line, index) => (
              <Box key={index}>
                <Text color={colors.accent}>{index === 0 ? `${composerMark} ` : "  "}</Text>
                <Text>{line}</Text>
                {index === inputLines.length - 1 ? <Text inverse> </Text> : null}
              </Box>
            ))
          : (
            <>
              {/* The question wraps in Ink; clipping it could hide the dangerous tail of a command (#635). */}
              <Text color={colors.warning}>
                {sanitizePromptText(question.text.replace(/\r?\n/g, " "))}
                {question.diff === undefined ? null : " · tab ver diff"}
              </Text>
              {input === ""
                ? <Text dimColor>{"enter responde · ctrl+c cancela"}</Text>
                : (
                  <Text>
                    <Text color={colors.accent}>{"❯ "}</Text>
                    {sanitizePromptText(input)}▏
                  </Text>
                )}
            </>
          )}
      </Box>
      {question === undefined ? (
        <Text dimColor>
          {busy ? "  enter entra na fila · ctrl+t recolhe pensamento · shift+enter nova linha" : "  enter envia · shift+enter nova linha"}
        </Text>
      ) : null}
      {win.start > 0 ? <Text dimColor>  …</Text> : null}
      {visibleSuggestions.map((item, offset) => {
        const index = win.start + offset;
        const isSelected = index === selectedIndex;
        const description = commandDescription(item);
        return (
          <Text key={item} {...(isSelected ? { color: colors.accent } : { dimColor: true })}>
            {isSelected ? "> " : "  "}{item}
            {description === undefined ? null : <Text dimColor>{`  ${description}`}</Text>}
          </Text>
        );
      })}
      {win.end < suggestions.length ? <Text dimColor>  …</Text> : null}
      <Text dimColor>
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






