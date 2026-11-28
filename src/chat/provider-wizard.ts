/** Shared provider wizard (#629): one flow for the REPL and the TUI and one vault write path. */
import { PROVIDER_CATALOG, type CatalogEntry } from "../providers/catalog";
import type { ProfileDraft, ProfileManager, ProfileView } from "../providers/profile-manager";
import type { ProfileModel, ProviderProfile } from "../providers/profiles";
import { isEnvName, isVaultCredentialRef, looksLikeSecret } from "../secrets";
import { redactSecrets } from "../sanitize-external";

export interface WizardIO {
  read(prompt: string, opts?: { secret?: boolean; initialValue?: string }): Promise<string | null>;
  write(text: string): void;
  select?(label: string, options: readonly string[], initial?: number): Promise<number | null>;
}

export interface WizardOptions {
  mode: "add" | "edit";
  profile?: ProviderProfile;
  /** Nome inicial vindo de `/provider add <nome>`. */
  initialName?: string;
  /** Ink edits the existing ref; an explicitly emptied field removes it. */
  clearCredentialOnEmpty?: boolean;
  /** Distinguishes cancellation from validation and persistence failures. */
  onCancel?: () => void;
  onUse?: (id: string) => void;
  /** Last check before saving; a returned message aborts without writing. */
  validate?: (draft: ProfileDraft) => string | undefined;
  saveSecret?: (providerId: string, secret: string) => string;
  discardSecret?: (ref: string) => void;
  activate?: "ask" | "never";
}

const DEFAULT_CONTEXT = 128_000;

/** Mesmo padrão de `ENV_NAME` em src/providers/profiles.ts: nome de variável de ambiente. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function messageOf(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const replaced = secret === undefined || secret === "" ? message : message.replaceAll(secret, "[redacted]");
  return redactSecrets(replaced);
}

async function ask(io: WizardIO, label: string, fallback: string): Promise<string | undefined> {
  const suffix = fallback === "" ? "" : ` [${fallback}]`;
  const answer = await io.read(`${label}${suffix}: `);
  if (answer === null) return undefined;
  const trimmed = answer.trim();
  return trimmed === "" ? fallback : trimmed;
}

async function choose(io: WizardIO, label: string, options: readonly string[], initial = 0): Promise<number | undefined> {
  if (io.select !== undefined) {
    const index = await io.select(label, options, initial);
    return index === null ? undefined : index;
  }
  const answer = await io.read(`${label} [${options.join("/")}]: `);
  if (answer === null) return undefined;
  const value = answer.trim();
  if (value === "") return initial;
  const index = options.indexOf(value);
  if (index < 0) { io.write("unknown option"); return undefined; }
  return index;
}

function modelsFrom(ids: string, known: readonly ProfileModel[]): ProfileModel[] {
  return ids
    .split(/[;,]/)
    .map((id) => id.trim())
    .filter((id) => id !== "")
    .map((id) => {
      const existing = known.find((model) => model.id === id);
      return existing === undefined
        ? { id, tags: [], context: DEFAULT_CONTEXT }
        : { id: existing.id, tags: [...existing.tags], context: existing.context };
    });
}

function catalogFor(key: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.key === key);
}

export interface SaveProviderOptions {
  manager: ProfileManager;
  mode: "add" | "edit";
  profile?: ProviderProfile;
  draft: ProfileDraft;
  /** Pending pasted key; the only path that writes the vault. */
  secret?: string;
  saveSecret?: (providerId: string, secret: string) => string;
  discardSecret?: (ref: string) => void;
}

/** Single persistence path with vault/profile rollback; an edit failure keeps the old ref (#629). */
export function saveProviderProfile(opts: SaveProviderOptions): { saved?: ProfileView; error?: string } {
  if (opts.secret !== undefined && (opts.saveSecret === undefined || opts.discardSecret === undefined)) return { error: "cofre de credenciais indisponível nesta tela; use uma variável de ambiente" };
  const editId = opts.mode === "edit" ? opts.profile?.id : undefined;
  if (opts.mode === "edit" && editId === undefined) return { error: "provider to edit was not provided" };
  let saved: ProfileView | undefined, addedId: string | undefined, createdRef: string | undefined;
  try {
    if (editId === undefined) { saved = opts.manager.add(opts.draft); addedId = saved.id; }
    const id = editId ?? saved!.id;
    if (opts.secret !== undefined) createdRef = opts.saveSecret!(id, opts.secret);
    if (editId !== undefined || createdRef !== undefined) saved = opts.manager.edit(id, { ...opts.draft, ...(createdRef === undefined ? {} : { credentialRef: createdRef }) });
  } catch (error) {
    if (createdRef !== undefined) opts.discardSecret?.(createdRef);
    if (addedId !== undefined) {
      try { opts.manager.remove(addedId); } catch { /* preserva o erro original */ }
    }
    return { error: messageOf(error, opts.secret) };
  }
  return { saved };
}

export async function runProviderWizard(
  io: WizardIO,
  manager: ProfileManager,
  opts: WizardOptions,
): Promise<ProfileView | undefined> {
  const current = opts.profile;
  const cancel = (): undefined => { opts.onCancel?.(); return undefined; };
  let entry: CatalogEntry | undefined;

  if (opts.mode === "add") {
    const options = ["custom", ...PROVIDER_CATALOG.map((item) => item.key)];
    const index = await choose(io, "De onde partir?", options, 0);
    if (index === undefined) return cancel();
    if (index > 0) {
      entry = catalogFor(options[index]!);
      if (entry === undefined) return undefined;
    }
  }

  const name = await ask(io, "Nome", current?.name ?? opts.initialName ?? entry?.name ?? "");
  if (name === undefined || name === "") {
    io.write("cancelado");
    return cancel();
  }
  const kind = current?.kind ?? entry?.kind ?? "openai-compat";
  const knownModels = [...(current?.models ?? []), ...(entry?.models ?? [])];

  let baseUrl: string | undefined;
  let credentialsPath: string | undefined;

  if (kind === "codex-oauth") {
    credentialsPath = await ask(
      io,
      "Credenciais (arquivo)",
      current?.credentialsPath ?? entry?.credentialsPath ?? "~/.codex/auth.json",
    );
    if (credentialsPath === undefined) return cancel();
  } else {
    for (;;) {
      baseUrl = await ask(io, "Base URL", current?.baseUrl ?? entry?.baseUrl ?? "");
      if (baseUrl === undefined) return cancel();
      if (baseUrl !== "") break;
      io.write("base url é obrigatória");
    }
  }

  let models: ProfileModel[] = [];
  for (;;) {
    const modelsAnswer = await ask(
      io,
      "Modelos (separe com ;)",
      (current?.models ?? entry?.models ?? []).map((model) => model.id).join(";"),
    );
    if (modelsAnswer === undefined) return cancel();
    models = modelsFrom(modelsAnswer, knownModels);
    if (models.length > 0) break;
    io.write("informe ao menos um modelo");
  }

  let credentialRef = current?.credentialRef ?? entry?.credentialRef;
  let secret: string | undefined;
  if (kind !== "codex-oauth") {
    for (;;) {
      const suffix = credentialRef === undefined ? "" : ` [${credentialRef}]`;
      const answer = await io.read(`Variável da chave (vazio = sem chave)${suffix}: `, {
        secret: true,
        ...(credentialRef === undefined ? {} : { initialValue: credentialRef }),
      });
      if (answer === null) return cancel();
      const value = answer.trim();
      if (value === "") {
        if (opts.clearCredentialOnEmpty === true) credentialRef = undefined;
        break;
      }
      if (looksLikeSecret(value)) {
        if (opts.saveSecret === undefined || opts.discardSecret === undefined) {
          io.write("cofre de credenciais indisponível nesta tela; use uma variável de ambiente");
          continue;
        }
        secret = value;
        credentialRef = undefined;
        break;
      }
      if (isEnvName(value) || isVaultCredentialRef(value)) {
        credentialRef = value;
        break;
      }
      io.write("use o nome da variável (ex.: OPENAI_API_KEY) ou cole a chave completa");
    }
  }

  const quotaDomain = current?.quotaDomain ?? entry?.quotaDomain ?? entry?.key;
  const draft: ProfileDraft = {
    name,
    kind,
    models,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(credentialsPath === undefined ? {} : { credentialsPath }),
    ...(quotaDomain === undefined ? {} : { quotaDomain }),
    ...(current?.headers === undefined ? {} : { headers: current.headers }),
  };

  const invalid = opts.validate?.(draft);
  if (invalid !== undefined) {
    io.write(invalid);
    return undefined;
  }

  io.write([
    `${opts.mode === "edit" ? "editar" : "novo"} provider: ${draft.name}`,
    `  nome:    ${draft.name}`,
    ...(draft.baseUrl === undefined ? [] : [`  baseUrl: ${draft.baseUrl}`]),
    ...(draft.credentialsPath === undefined ? [] : [`  arquivo: ${draft.credentialsPath}`]),
    `  modelos: ${draft.models.map((model) => model.id).join(", ")}`,
    `  chave:   ${secret !== undefined ? "vault:<novo>" : draft.credentialRef ?? "-"}`,
  ].join("\n"));
  const confirm = await ask(io, "Confirmar", "S");
  if (confirm === undefined || confirm.toLowerCase().startsWith("n")) {
    io.write("cancelado");
    return cancel();
  }

  const result = saveProviderProfile({
    manager,
    mode: opts.mode,
    ...(current === undefined ? {} : { profile: current }),
    draft,
    ...(secret === undefined ? {} : { secret }),
    ...(opts.saveSecret === undefined ? {} : { saveSecret: opts.saveSecret }),
    ...(opts.discardSecret === undefined ? {} : { discardSecret: opts.discardSecret }),
  });
  if (result.saved === undefined) {
    io.write(`erro: ${result.error ?? "falha ao salvar"}`);
    return undefined;
  }
  const saved = result.saved;

  if (draft.credentialRef !== undefined && !manager.credentialPresent(draft.credentialRef)) {
    io.write(`! ${draft.credentialRef} não encontrada no ambiente; exporte antes de usar`);
  }

  if (opts.mode === "add" && opts.activate !== "never") {
    const activate = await ask(io, "ativar agora?", "S");
    if (activate !== undefined && !activate.toLowerCase().startsWith("n")) {
      try {
        manager.use(saved.id);
        opts.onUse?.(saved.id);
        io.write(`provider ativo: ${saved.id}`);
      } catch (error) {
        io.write(`erro: ${messageOf(error, secret)}`);
      }
    }
  }

  io.write(`salvo: ${saved.id}`);
  return saved;
}
