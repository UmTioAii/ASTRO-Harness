/** Tela cheia de providers (TUI): lista + wizard compartilhado + modelos por provider (#555), sem tocar segredo. */
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ProfileManager, ProfileView } from "../providers/profile-manager";
import type { HealthCheck } from "../health";
import type { CodexLoginStart } from "../providers/codex-login";
import { priceLabel } from "../pricing";
import { redactSecrets } from "../sanitize-external";
import { isEnvName, isVaultCredentialRef, looksLikeSecret } from "../secrets";
import { formatProviderCheck } from "./health";
import type { ModelOption } from "./models";
import type { ThemeColors } from "./theme";
import { ProviderWizardForm } from "./provider-wizard-form";

export interface ProviderScreenProps {
  manager: ProfileManager;
  colors: ThemeColors;
  /** Modelo `provider/id` em uso pela sessão, para diferenciar do ativo salvo. */
  currentModel?: string;
  /** `credential` (#616): recovery starts at the credential step, keeping the rest of the profile. */
  initial?: { mode: "list" | "add" | "edit" | "remove" | "credential"; target?: string };
  onClose: () => void;
  onActivate: (id: string) => void;
  /** Recovery (#616): writes the new ref in the layer that owns the provider. */
  onCredentialRef?: (id: string, ref: string) => void;
  onChanged?: () => void;
  /** Modelos com metadados (cards) para a troca inline de modelo por provider (#555). */
  modelInfo?: readonly ModelOption[];
  /** Troca o modelo da sessão a partir de `ref` (`provider/id`) dentro do provider (#555). */
  onSelectModel?: (ref: string) => void;
  /** Teste real mínimo do provider (C6); ausente desabilita `t`. */
  onTest?: (id: string) => Promise<HealthCheck>;
  /** Login device flow do Codex; ausente desabilita `l`. */
  onLogin?: (id: string, signal?: AbortSignal) => Promise<CodexLoginStart>;
  /** Salva uma chave digitada no cofre e devolve `vault:<id>`; ausente = cofre indisponível. */
  onSaveSecret?: (providerId: string, secret: string) => string;
  /** Desfaz uma credencial recém-criada quando o perfil não pôde ser gravado. */
  onDiscardSecret?: (ref: string) => void;
}

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export interface ProviderAction {
  readonly key: string;
  readonly label: string;
  readonly run: () => void;
}

/** Ações do menu da lista de providers: numeradas (1-9), despachadas por `run`. */
export function listActions(opts: {
  current: ProfileView | undefined;
  canTest: boolean;
  canLogin: boolean;
  add: () => void;
  activate: () => void;
  edit: () => void;
  remove: () => void;
  test: () => void;
  login: () => void;
  close: () => void;
}): ProviderAction[] {
  const actions: ProviderAction[] = [{ key: "1", label: "Adicionar provider", run: opts.add }];
  if (opts.current !== undefined) {
    actions.push({ key: `${actions.length + 1}`, label: "Definir como ativo", run: opts.activate });
    actions.push({ key: `${actions.length + 1}`, label: "Editar", run: opts.edit });
    actions.push({ key: `${actions.length + 1}`, label: "Remover", run: opts.remove });
    if (opts.canTest) actions.push({ key: `${actions.length + 1}`, label: "Testar conexão", run: opts.test });
    if (opts.canLogin) actions.push({ key: `${actions.length + 1}`, label: "Login Codex", run: opts.login });
  }
  actions.push({ key: `${actions.length + 1}`, label: "Fechar", run: opts.close });
  return actions;
}

export function ProviderScreen({
  manager, colors, currentModel, initial, onClose, onActivate, onChanged, modelInfo, onSelectModel, onTest, onLogin, onSaveSecret, onDiscardSecret, onCredentialRef,
}: ProviderScreenProps): ReactElement {
  const initialList = manager.list();
  const initialTarget = initial?.target === undefined
    ? undefined
    : initialList.find((item) => item.id === initial.target)
      ?? initialList.find((item) => item.name.toLowerCase() === initial.target!.toLowerCase());
  const initialEdit = initial?.mode === "edit" && initialTarget?.source === "global" ? initialTarget : undefined;
  const initialRemove = initial?.mode === "remove" && initialTarget?.source === "global" ? initialTarget : undefined;
  const recovering = initial?.mode === "credential" ? initialTarget : undefined;
  const [view, setView] = useState<"list" | "form" | "remove" | "models">(
    initial?.mode === "add"
      ? "form"
      : initial?.mode === "edit"
        ? initialEdit === undefined ? "list" : "form"
        : initial?.mode === "remove"
          ? initialRemove === undefined ? "list" : "remove"
          : initial?.mode === "credential" ? (recovering === undefined ? "list" : "form") : "list",
  );
  const [initialName, setInitialName] = useState(initial?.mode === "add" ? initial.target : undefined);
  const [selected, setSelected] = useState(() => {
    if (initialTarget === undefined) return 0;
    const index = initialList.findIndex((item) => item.id === initialTarget.id);
    return index < 0 ? 0 : index;
  });
  const [editing, setEditing] = useState<ProfileView | undefined>(initialEdit ?? recovering);
  const [credential, setCredential] = useState(initialEdit?.credentialRef ?? "");
  const [message, setMessage] = useState<string | undefined>(() => {
    if (initial?.target === undefined) return undefined;
    if (initialTarget === undefined) return `provider "${initial.target}" não encontrado`;
    if (initial?.mode === "edit" && initialEdit === undefined) {
      return `provider "${initial.target}" é ${initialTarget.source}; edite pelo astro chat`;
    }
    if (initial?.mode === "remove" && initialRemove === undefined) {
      return `provider "${initial.target}" é ${initialTarget.source}; não removível aqui`;
    }
    return undefined;
  });
  const [testTarget, setTestTarget] = useState<ProfileView | undefined>(undefined);
  const [testing, setTesting] = useState(false);
  const [messageOk, setMessageOk] = useState(false);
  const [login, setLogin] = useState<{ target: ProfileView; url: string; userCode: string } | undefined>(undefined);
  const [loginTarget, setLoginTarget] = useState<ProfileView | undefined>(undefined);
  const [loginStarting, setLoginStarting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  /** Provider cuja view de modelos está aberta (#555) e índice do modelo selecionado nela. */
  const [modelsProvider, setModelsProvider] = useState<ProfileView | undefined>(undefined);
  const [modelIndex, setModelIndex] = useState(0);
  const probeToken = useRef(0);
  const loginAbort = useRef<AbortController | undefined>(undefined);
  const loginBusy = useRef(false);

  useEffect(() => () => { loginAbort.current?.abort(); }, []);


  const list = manager.list();
  const current = list[Math.min(selected, Math.max(list.length - 1, 0))];

  /**
   * Modelos de um provider para a troca inline (#555): vem de `modelInfo`
   * (cards com status/preço); sem `modelInfo`, cai nos modelos declarados do
   * perfil, todos como "active".
   */
  const modelsOf = (providerId: string): ModelOption[] => {
    const fromInfo = (modelInfo ?? []).filter((model) => model.provider === providerId);
    if (fromInfo.length > 0) return [...fromInfo];
    const profile = list.find((item) => item.id === providerId);
    return (profile?.models ?? []).map((model) => ({
      ref: `${providerId}/${model.id}`,
      provider: providerId,
      id: model.id,
      tags: model.tags,
      context: model.context,
      status: "active",
    }));
  };

  const startAdd = (): void => {
    setInitialName(undefined);
    setEditing(undefined);
    setMessage(undefined);
    setView("form");
  };

  const startEdit = (profile: ProfileView): void => {
    if (profile.source !== "global") {
      setMessage(profile.source === "project"
        ? `provider "${profile.id}" está definido no astro.config.json`
        : `provider "${profile.id}" é efêmero (env)`);
      return;
    }
    setEditing(profile);
    setMessage(undefined);
    setView("form");
  };

  const handleSaved = (saved: ProfileView): void => {
    let activationError: string | undefined;
    if (editing === undefined) {
      try {
        manager.use(saved.id);
      } catch (error) {
        activationError = messageOf(error);
      }
    }
    onChanged?.();
    if (editing === undefined && activationError === undefined) {
      try {
        onActivate(saved.id);
      } catch (error) {
        activationError = messageOf(error);
      }
    }
    setView("list");
    setMessage(activationError === undefined ? `salvo: ${saved.id}` : `salvo: ${saved.id} (não ativado: ${activationError})`);
  };

  /** Recovery (#616): the key goes to the vault (or an env name is kept) and only the ref is written. */
  const recoverCredential = (): void => {
    const target = editing;
    if (target === undefined) return;
    if (onCredentialRef === undefined) { setMessage("recuperação de credencial indisponível nesta tela"); return; }
    const value = credential.trim();
    if (value === "") { onClose(); return; } // empty = cancel, nothing written
    let created: string | undefined;
    let ref = value;
    if (looksLikeSecret(value)) {
      if (onSaveSecret === undefined) { setMessage("cofre de credenciais indisponível nesta tela; use uma variável de ambiente"); return; }
      try { ref = created = onSaveSecret(target.id, value); } catch (error) { setMessage(messageOf(error)); return; }
    } else if (!isEnvName(value) && !isVaultCredentialRef(value)) {
      setMessage("use o nome da variável (ex.: OPENAI_API_KEY) ou cole a chave completa");
      return;
    }
    try {
      onCredentialRef(target.id, ref);
    } catch (error) {
      if (created !== undefined) onDiscardSecret?.(created); // no orphan key on a refused write
      setMessage(messageOf(error));
      return;
    }
    onActivate(target.id);
  };

  const startLogin = (profile: ProfileView): void => {
    if (onLogin === undefined || loginBusy.current) return;
    loginBusy.current = true;
    setLoginStarting(true);
    const controller = new AbortController();
    loginAbort.current = controller;
    setMessage(undefined);
    void onLogin(profile.id, controller.signal)
      .then((start) => {
        if (controller.signal.aborted) {
          void start.done.catch(() => undefined);
          return undefined;
        }
        setLoginStarting(false);
        setLogin({ target: profile, url: start.device.verificationUrl, userCode: start.device.userCode });
        return start.done;
      })
      .then(() => {
        if (controller.signal.aborted) return;
        let warning = "";
        try {
          if (profile.source === "global") manager.use(profile.id);
        } catch (error) {
          warning = ` (não persistido: ${messageOf(error)})`;
        }
        setLogin(undefined);
        setMessageOk(true);
        setMessage(`${profile.id}: login concluído${warning}`);
        onChanged?.();
        onActivate(profile.id);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLogin(undefined);
        setMessageOk(false);
        setMessage(`erro: ${messageOf(error)}`);
      })
      .finally(() => {
        loginBusy.current = false;
        setLoginStarting(false);
      });
  };

  const activateCurrent = (): void => {
    if (current === undefined) return;
    try {
      if (current.source === "global") manager.use(current.id);
      onActivate(current.id);
      setMessage(`ativo: ${current.id}`);
      onChanged?.();
    } catch (error) {
      setMessage(messageOf(error));
    }
  };

  const testCurrent = (): void => {
    if (onTest === undefined || current === undefined) return;
    setMessage(undefined);
    setTestTarget(current);
  };

  const loginCurrent = (): void => {
    if (onLogin === undefined || current === undefined || current.kind !== "codex-oauth") return;
    setMessage(undefined);
    setLoginTarget(current);
  };

  const editCurrent = (): void => {
    if (current !== undefined) startEdit(current);
  };

  const removeCurrent = (): void => {
    if (current === undefined) return;
    if (current.source !== "global") {
      setMessage(current.source === "project"
        ? `provider "${current.id}" está definido no astro.config.json`
        : `provider "${current.id}" é efêmero (env)`);
      return;
    }
    setView("remove");
  };

  const actions = listActions({
    current,
    canTest: onTest !== undefined,
    canLogin: onLogin !== undefined && current?.kind === "codex-oauth",
    add: startAdd,
    activate: activateCurrent,
    edit: editCurrent,
    remove: removeCurrent,
    test: testCurrent,
    login: loginCurrent,
    close: onClose,
  });

  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "d")) {
      loginAbort.current?.abort();
      onClose();
      return;
    }
    if (loginTarget !== undefined) {
      if (key.escape) {
        setLoginTarget(undefined);
        setMessage(undefined);
        return;
      }
      if (key.return) {
        const target = loginTarget;
        setLoginTarget(undefined);
        startLogin(target);
      }
      return;
    }
    if (loginStarting) {
      if (key.escape) {
        loginAbort.current?.abort();
        setLoginStarting(false);
        setMessageOk(false);
        setMessage("login cancelado");
      }
      return;
    }
    if (login !== undefined) {
      if (key.escape) {
        loginAbort.current?.abort();
        loginAbort.current = undefined;
        setLogin(undefined);
        setMessageOk(false);
        setMessage("login cancelado");
      }
      return;
    }
    if (testTarget !== undefined) {
      if (key.escape) {
        probeToken.current++;
        setTestTarget(undefined);
        setTesting(false);
        setMessage(undefined);
        return;
      }
      if (key.return && !testing) {
        const token = ++probeToken.current;
        const target = testTarget;
        setTesting(true);
        setMessage(undefined);
        void onTest?.(target.id)
          .then((check) => {
            if (token !== probeToken.current) return;
            setMessage(`${target.id}: ${formatProviderCheck(check)}`);
            setMessageOk(check.status === "ok");
          })
          .catch((error) => {
            if (token !== probeToken.current) return;
            setMessage(`erro: ${messageOf(error)}`);
            setMessageOk(false);
          })
          .finally(() => {
            if (token !== probeToken.current) return;
            setTesting(false);
            setTestTarget(undefined);
          });
      }
      return;
    }
    if (view === "list") {
      if (menuOpen) {
        if (key.escape || input === "m") { setMenuOpen(false); return; }
        if (key.upArrow) { setMenuIndex((value) => (value - 1 + actions.length) % actions.length); return; }
        if (key.downArrow) { setMenuIndex((value) => (value + 1) % actions.length); return; }
        const run = key.return
          ? actions[menuIndex]?.run
          : input >= "1" && input <= "9"
            ? actions[Number(input) - 1]?.run
            : undefined;
        if (run !== undefined) {
          setMenuOpen(false);
          setMenuIndex(0);
          run();
        }
        return;
      }
      if (key.escape) { onClose(); return; }
      if (key.upArrow) { setSelected((value) => Math.max(0, value - 1)); setMessage(undefined); return; }
      if (key.downArrow) { setSelected((value) => Math.min(list.length - 1, value + 1)); setMessage(undefined); return; }
      if (input === "m") { setMenuOpen(true); setMenuIndex(0); return; }
      if (key.rightArrow && current !== undefined && onSelectModel !== undefined) {
        // drill-down de modelos do provider selecionado (#555); enter continua = ativar
        setModelsProvider(current);
        setModelIndex(0);
        setView("models");
        return;
      }
      if (input === "a") { startAdd(); return; }
      if (input === "t") { testCurrent(); return; }
      if (input === "l") { loginCurrent(); return; }
      if (input === "e") { editCurrent(); return; }
      if (input === "d") { removeCurrent(); return; }
      if (key.return) { activateCurrent(); return; }
      return;
    }

    if (view === "models") {
      const models = modelsProvider === undefined ? [] : modelsOf(modelsProvider.id);
      if (key.escape) { setView("list"); setModelsProvider(undefined); return; }
      if (key.upArrow) { setModelIndex((value) => Math.max(0, value - 1)); return; }
      if (key.downArrow) { setModelIndex((value) => Math.min(models.length - 1, value + 1)); return; }
      if (key.return && models.length > 0 && onSelectModel !== undefined) {
        const model = models[Math.min(modelIndex, models.length - 1)]!;
        setView("list");
        setModelsProvider(undefined);
        onSelectModel(model.ref);
      }
      return;
    }

    if (view === "remove") {
      if (input === "s" && current !== undefined) {
        try {
          manager.remove(current.id);
          onChanged?.();
              setMessage(`removido: ${current.id}`);
        } catch (error) {
          setMessage(messageOf(error));
        }
        setView("list");
        return;
      }
      if (input === "n" || key.escape) setView("list");
      return;
    }

    if (recovering !== undefined) {
      // Recovery is a single step: enter saves the ref, esc cancels (#616).
      if (key.escape) { onClose(); return; }
      if (key.return) { recoverCredential(); return; }
      if (key.backspace || key.delete) { setCredential((value) => value.slice(0, -1)); return; }
      if (input !== "") setCredential((value) => value + input);
      return;
    }

    // Add/edit is rendered and driven by the shared wizard (#629).
    if (view === "form") return;
  });

  if (loginTarget !== undefined) {
    const shownPath = (loginTarget.credentialsPath ?? "~/.codex/auth.json")
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Login Codex: {loginTarget.name}</Text>
        <Text>grava em {shownPath}</Text>
        <Text dimColor>enter confirmar · esc cancelar</Text>
      </Box>
    );
  }

  if (loginStarting) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Login Codex: iniciando…</Text>
        <Text dimColor>esc cancela</Text>
      </Box>
    );
  }

  if (login !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Login Codex: {login.target.name}</Text>
        <Text>abra {login.url} e informe o código {login.userCode}</Text>
        <Text dimColor>aguardando… esc cancela</Text>
        {message === undefined ? null : <Text color={messageOk ? colors.accent : colors.error}>{message}</Text>}
      </Box>
    );
  }

  if (testTarget !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Testar {testTarget.name}?</Text>
        <Text dimColor>{testing ? "testando…" : "enter confirmar · esc cancelar"}</Text>
        {message === undefined ? null : <Text color={messageOk ? colors.accent : colors.error}>{message}</Text>}
      </Box>
    );
  }

  if (view === "remove" && current !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Remover {current.name}?</Text>
        <Text dimColor>s remover · n cancelar</Text>
        {message === undefined ? null : <Text color={colors.error}>{message}</Text>}
      </Box>
    );
  }

  if (view === "form") {
    if (recovering !== undefined) {
      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{`Editar ${recovering.id}`}</Text>
          <Text>Chave colada (cofre) ou variável de ambiente · vazio = cancelar</Text>
          <Text color={colors.accent}>{"*".repeat(credential.length) || " "}</Text>
          <Text dimColor>enter salvar · esc cancelar</Text>
          {message === undefined ? null : <Text color={colors.error}>{message}</Text>}
        </Box>
      );
    }
    return (
      <ProviderWizardForm
        manager={manager}
        colors={colors}
        {...(initialName === undefined ? {} : { initialName })}
        {...(editing === undefined ? {} : { profile: editing })}
        {...(onSaveSecret === undefined ? {} : { saveSecret: onSaveSecret })}
        {...(onDiscardSecret === undefined ? {} : { discardSecret: onDiscardSecret })}
        onSaved={handleSaved}
        onCancel={() => { setMessage(undefined); setView("list"); }}
        onFailed={(text) => { setMessage(text); setView("list"); }}
      />
    );
  }

  if (view === "models" && modelsProvider !== undefined) {
    const models = modelsOf(modelsProvider.id);
    const cursor = Math.min(modelIndex, Math.max(models.length - 1, 0));
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>Modelos de {modelsProvider.name} ({modelsProvider.id})</Text>
        {models.length === 0 ? <Text dimColor>nenhum modelo declarado</Text> : null}
        {models.map((model, index) => (
          <Text key={model.ref} color={index === cursor ? colors.accent : undefined}>
            {index === cursor ? "> " : "  "}
            {model.ref} {model.status} contexto {model.context ?? "?"} · {priceLabel(model.ref, model.price)}
          </Text>
        ))}
        <Text dimColor>↑↓ escolher · enter trocar modelo · esc voltar</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Providers</Text>
      {currentModel === undefined ? null : <Text dimColor>em uso: {currentModel}</Text>}
      {list.length === 0 ? <Text dimColor>nenhum provider</Text> : null}
      {list.map((profile, index) => (
        <Text key={profile.id} color={index === selected ? colors.accent : undefined}>
          {index === selected ? "> " : "  "}
          {profile.source === "env" ? "◐" : profile.active ? "●" : "○"} {profile.name} ({profile.id}){" "}
          {profile.kind} {profile.baseUrl ?? profile.credentialsPath ?? "-"}{" "}
          cred={profile.credentialRef ?? "sem chave"} [{profile.source}]
        </Text>
      ))}
      {menuOpen ? (
        <Box flexDirection="column">
          <Text bold>Ações</Text>
          {actions.map((action, index) => (
            <Text key={action.key} color={index === menuIndex ? colors.accent : undefined}>
              {index === menuIndex ? "> " : "  "}{action.key} {action.label}
            </Text>
          ))}
          <Text dimColor>↑↓ escolher · enter executar · 1-9 direto · m/esc fechar</Text>
        </Box>
      ) : null}
      <Text dimColor>
        {["m menu", "a adicionar", "e editar", "d remover",
          ...(onSelectModel === undefined ? [] : ["→ modelos"]),
          ...(onTest === undefined ? [] : ["t testar"]),
          ...(onLogin === undefined || current?.kind !== "codex-oauth" ? [] : ["l login"]),
          "enter ativar", "esc voltar"].join(" · ")}
      </Text>
      {message === undefined ? null : <Text color={messageOk ? colors.accent : colors.error}>{message}</Text>}
    </Box>
  );
}
