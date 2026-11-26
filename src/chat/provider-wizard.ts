/** Shared provider wizard (#629): one flow for the REPL and the TUI and one vault write path. */
import { PROVIDER_CATALOG, type CatalogEntry } from "../providers/catalog";
import type { ProfileDraft, ProfileManager, ProfileView } from "../providers/profile-manager";
import type { ProfileModel, ProviderProfile } from "../providers/profiles";
import { isEnvName, isVaultCredentialRef, looksLikeSecret } from "../secrets";
import { redactSecrets } from "../sanitize-external";

export interface WizardIO {
  read(prompt: string, opts?: { secret?: boolean }): Promise<string | null>;
  write(text: string): void;
  /** TUI renders an arrow selector; without it the answer is typed as text. */
  select?(label: string, options: readonly string[], initial?: number): Promise<number | null>;
}

export interface WizardOptions {
  mode: "add" | "edit";
  profile?: ProviderProfile;
  /** Nome inicial vindo de `/provider add <nome>`. */
  initialName?: string;
  onUse?: (id: string) => void;
  /** Last check before saving; a returned message aborts without writing. */
  validate?: (draft: ProfileDraft) => string | undefined;
  /**
   * #629: the single vault write path. The TUI passes `createSecretHandlers`;
   * without it a pasted secret is refused and only an env name is accepted.
   */
  saveSecret?: (providerId: string, secret: string) => string;
  discardSecret?: (ref: string) => void;
  /** `ask` (REPL default) or `never` (the TUI activates after the wizard returns). */
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
  if (index < 0) {
    io.write("unknown option");
    return undefined;
  }
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

export interface SaveProviderResult {
  saved?: ProfileView;
  error?: string;
}

/**
 * Single provider persistence path (#629): the profile first, then the vault ref,
 * with rollback when a later step fails. A vault failure on edit keeps the old ref;
 * a profile failure after the vault write discards the new credential.
 */
export function saveProviderProfile(opts: SaveProviderOptions): SaveProviderResult {
  if (opts.secret !== undefined && (opts.saveSecret === undefined || opts.discardSecret === undefined)) {
    return { error: "cofre de credenciais indisponível nesta tela; use uma variável de ambiente" };
  }
  let saved: ProfileView | undefined;
  let addedId: string | undefined;
  let createdRef: string | undefined;
  try {
    if (opts.secret !== undefined && opts.profile !== undefined) {
      // Edit: the vault write happens before the profile; a failure keeps the old ref.
      createdRef = opts.saveSecret!(opts.profile.id, opts.secret);
      saved = opts.manager.edit(opts.profile.id, { ...opts.draft, credentialRef: createdRef });
    } else if (opts.profile === undefined) {
      saved = opts.manager.add(opts.draft);
      addedId = saved.id;
      if (opts.secret !== undefined) {
        createdRef = opts.saveSecret!(saved.id, opts.secret);
        saved = opts.manager.edit(saved.id, { ...opts.draft, credentialRef: createdRef });
      }
    } else {
      saved = opts.manager.edit(opts.profile.id, opts.draft);
    }
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
  let entry: CatalogEntry | undefined;

  if (opts.mode === "add") {
    const options = ["custom", ...PROVIDER_CATALOG.map((item) => item.key)];
    const index = await choose(io, "De onde partir?", options, 0);
    if (index === undefined) return undefined;
    if (index > 0) {
      entry = catalogFor(options[index]!);
      if (entry === undefined) return undefined;
    }
  }

  const name = await ask(io, "Nome", current?.name ?? opts.initialName ?? entry?.name ?? "");
  if (name === undefined || name === "") {
    io.write("cancelado");
    return undefined;
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
    if (credentialsPath === undefined) return undefined;
  } else {
    for (;;) {
      baseUrl = await ask(io, "Base URL", current?.baseUrl ?? entry?.baseUrl ?? "");
      if (baseUrl === undefined) return undefined;
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
    if (modelsAnswer === undefined) return undefined;
    models = modelsFrom(modelsAnswer, knownModels);
    if (models.length > 0) break;
    io.write("informe ao menos um modelo");
  }

  let credentialRef = current?.credentialRef;
  let secret: string | undefined;
  if (kind !== "codex-oauth") {
    for (;;) {
      const suffix = credentialRef === undefined ? "" : ` [${credentialRef}]`;
      const answer = await io.read(`Variável da chave (vazio = sem chave)${suffix}: `, { secret: true });
      if (answer === null) return undefined;
      const value = answer.trim();
      if (value === "") break;
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
    return undefined;
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
