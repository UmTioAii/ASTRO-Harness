/** Perfis de provider persistidos fora do projeto (~/.astro/providers.json). Sem segredo. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BASELINE_MAX_STEPS, ConfigError, DEFAULT_AGENT_TOOLS, DEFAULT_ATTACHMENTS, DEFAULT_PATHS, inspectConfigDocument, isPlainObject, loadConfigRaw, validateConfig, writeConfigFileAtomic, type AstroConfig, type ModelConfig, type ProviderConfig } from "../core/config";
import { globalConfigPath, statePath } from "../astro-home";
import { loadHomeState, saveHomeState } from "../home-state";
import { assertDeclaredProviders, assertLayerSchema, assertNarrowed, mergeConfigLayers, mergeModelLayers } from "../config-overlay";
import { isKnownTag } from "../tags";
import { isAuthHeader, isEnvName, isVaultCredentialRef, looksLikeSecret } from "../secrets";
import { outboundUrlProblem } from "../url-safety";
import { vaultMeta, vaultPath, vaultPlainWarning } from "../vault";

export interface ProfileModel {
  id: string;
  tags: string[];
  context: number;
}

export interface ProviderProfile {
  id: string;
  name: string;
  kind: string;
  baseUrl?: string;
  /** Nome da variável de ambiente; nunca o valor. Ausente = provider sem chave. */
  credentialRef?: string;
  credentialsPath?: string;
  quotaDomain?: string;
  headers?: Record<string, string>;
  models: ProfileModel[];
}

export interface ProviderStore {
  version: 1;
  activeProfileId?: string;
  profiles: ProviderProfile[];
}

const ROOT_KEYS = new Set(["version", "activeProfileId", "profiles"]);
const PROFILE_KEYS = new Set([
  "id", "name", "kind", "baseUrl", "credentialRef", "credentialsPath", "quotaDomain", "headers", "models",
]);
const PROFILE_ID = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function fail(message: string): never {
  throw new Error(`perfil inválido: ${message}`);
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`"${field}" deve ser um objeto`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`"${field}" deve ser uma string não vazia`);
  }
  return value;
}

function rejectUnknown(raw: Record<string, unknown>, allowed: Set<string>, field: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(`campo desconhecido: "${field}.${key}"`);
  }
}

function validateHeaders(raw: unknown, field: string): Record<string, string> {
  const headers = asObject(raw, field);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isAuthHeader(name)) {
      fail(`header de autenticação não é permitido em "${field}": "${name.toLowerCase()}"`);
    }
    const text = asString(value, `${field}.${name}`);
    if (looksLikeSecret(text)) {
      fail(`"${field}.${name}" parece conter uma credencial; use credentialRef`);
    }
    out[name] = text;
  }
  return out;
}

function validateModel(raw: unknown, field: string): ProfileModel {
  const model = asObject(raw, field);
  rejectUnknown(model, new Set(["id", "tags", "context"]), field);
  const id = asString(model.id, `${field}.id`);
  if (!Array.isArray(model.tags)) fail(`"${field}.tags" deve ser uma lista de tags`);
  const tags = model.tags.map((tag, index) => {
    const name = asString(tag, `${field}.tags[${index}]`);
    // I-03: não ecoar a tag — ela pode ser um valor colado por engano.
    if (!isKnownTag(name)) fail(`tag desconhecida em "${field}.tags"`);
    return name;
  });
  const context = model.context;
  if (typeof context !== "number" || !Number.isInteger(context) || context <= 0) {
    fail(`"${field}.context" deve ser um inteiro positivo`);
  }
  return { id, tags, context };
}

function validateBaseUrl(value: unknown, field: string): string {
  const raw = asString(value, field);
  const problem = outboundUrlProblem(raw);
  if (problem !== undefined) fail(`"${field}" ${problem}`);
  return raw;
}

function validateProfile(raw: unknown, field: string): ProviderProfile {
  const profile = asObject(raw, field);
  rejectUnknown(profile, PROFILE_KEYS, field);
  const id = asString(profile.id, `${field}.id`);
  if (!PROFILE_ID.test(id) || id.length > 64) {
    fail(`"${field}.id" deve ser um slug (minúsculas, dígitos e hífen; até 64 caracteres)`);
  }
  const name = asString(profile.name, `${field}.name`);
  const kind = asString(profile.kind, `${field}.kind`);
  const baseUrl = profile.baseUrl === undefined ? undefined : validateBaseUrl(profile.baseUrl, `${field}.baseUrl`);
  const credentialRef = profile.credentialRef === undefined
    ? undefined
    : asString(profile.credentialRef, `${field}.credentialRef`);
  if (credentialRef !== undefined && !ENV_NAME.test(credentialRef) && !isVaultCredentialRef(credentialRef)) {
    fail(`"${field}.credentialRef" deve ser um nome de variável de ambiente (ex.: OPENAI_API_KEY) ou vault:<credentialId>`);
  }
  const credentialsPath = profile.credentialsPath === undefined
    ? undefined
    : asString(profile.credentialsPath, `${field}.credentialsPath`);
  const quotaDomain = profile.quotaDomain === undefined
    ? undefined
    : asString(profile.quotaDomain, `${field}.quotaDomain`);
  const headers = profile.headers === undefined
    ? undefined
    : validateHeaders(profile.headers, `${field}.headers`);
  if (!Array.isArray(profile.models) || profile.models.length === 0) {
    fail(`"${field}.models" deve ter ao menos um modelo`);
  }
  const models = profile.models.map((model, index) => validateModel(model, `${field}.models[${index}]`));
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) fail(`modelo duplicado em "${field}.models": "${model.id}"`);
    modelIds.add(model.id);
  }

  if (kind === "openai-compat" && baseUrl === undefined) {
    fail(`"${field}.baseUrl" é obrigatório para kind "openai-compat"`);
  }
  if (kind === "codex-oauth" && credentialsPath === undefined) {
    fail(`"${field}.credentialsPath" é obrigatório para kind "codex-oauth"`);
  }

  return {
    id, name, kind,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(credentialsPath === undefined ? {} : { credentialsPath }),
    ...(quotaDomain === undefined ? {} : { quotaDomain }),
    ...(headers === undefined ? {} : { headers }),
    models,
  };
}

/** Valida o store inteiro; campo desconhecido é erro, nunca ignorado. */
export function validateProfileStore(raw: unknown): ProviderStore {
  const root = asObject(raw, "store");
  rejectUnknown(root, ROOT_KEYS, "store");
  if (root.version !== 1) fail(`"version" deve ser 1`);
  if (!Array.isArray(root.profiles)) fail(`"profiles" deve ser uma lista`);
  const profiles = root.profiles.map((profile, index) => validateProfile(profile, `profiles[${index}]`));

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) fail(`id duplicado: "${profile.id}"`);
    const nameKey = profile.name.toLowerCase();
    // I-03: o nome é conteúdo do arquivo (pode ser um segredo colado); nunca ecoar.
    if (names.has(nameKey)) fail(`nome duplicado em "profiles"`);
    ids.add(profile.id);
    names.add(nameKey);
  }

  const activeProfileId = root.activeProfileId === undefined
    ? undefined
    : asString(root.activeProfileId, "activeProfileId");

  return {
    version: 1,
    ...(activeProfileId === undefined ? {} : { activeProfileId }),
    profiles,
  };
}

/** Caminho do store: `$ASTRO_HOME/providers.json` ou `~/.astro/providers.json`. */
export function profilesPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ASTRO_HOME?.trim();
  const base = home === undefined || home === "" ? join(homedir(), ".astro") : home;
  return join(base, "providers.json");
}

/** Store legado inválido: nomeia o arquivo e nunca ecoa o conteúdo (I-03). */
export class ProfileStoreError extends Error {
  override name = "ProfileStoreError";
  constructor(readonly path: string, detail: string) {
    super(`store de perfis inválido em "${path}": ${detail}`);
  }
}

/** Store legado aposentado pela migração: a escrita pertence a `config.json` (#459). */
export class ProfileStoreMigratedError extends Error {
  override name = "ProfileStoreMigratedError";
  readonly code = "profile_store_migrated";
  constructor(readonly configPath: string) {
    super(`store de perfis migrado para "${configPath}"; edite a configuração global`);
  }
}

/** Providers e modelos declarados na camada de projeto (o `loadProjectConfig` devolve a config mesclada com a global). */
export function projectLayerRefs(configPath: string): { providers: string[]; modelProviders: string[] } {
  if (!existsSync(configPath)) return { providers: [], modelProviders: [] };
  const raw = loadConfigRaw(configPath);
  return {
    providers: isPlainObject(raw.providers) ? Object.keys(raw.providers) : [],
    modelProviders: Array.isArray(raw.models)
      ? raw.models.flatMap((model) => (
          isPlainObject(model) && typeof model.provider === "string" ? [model.provider] : []
        ))
      : [],
  };
}

/** Store ausente é um store vazio; JSON corrompido é erro com o caminho. */
export function loadProfileStore(path: string = profilesPath()): ProviderStore {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { version: 1, profiles: [] };
    throw new ProfileStoreError(path, error instanceof Error ? error.message : String(error));
  }
  if (text.trim() === "") return { version: 1, profiles: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Nunca ecoar o detalhe do parser: ele cita os primeiros caracteres do
    // conteúdo colado, que pode ser uma chave (I-03).
    throw new ProfileStoreError(path, "JSON inválido");
  }
  try {
    return validateProfileStore(parsed);
  } catch (error) {
    throw new ProfileStoreError(path, error instanceof Error ? error.message : String(error));
  }
}

/** Arquivo irmão do store: `config.json` e `state.json` vivem no mesmo diretório. */
function siblingPath(storePath: string, name: string): string {
  return join(dirname(storePath), name);
}

/**
 * Escrita atômica da camada crua: usa o mesmo escritor da CLI (#495) —
 * tmp + fsync + rename, 0600 no POSIX, recusa symlink/destino não-regular.
 * A camada global é parcial: não valida o schema inteiro.
 */
function writeConfigRaw(raw: Record<string, unknown>, path: string): void {
  writeConfigFileAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
}

/**
 * Grava o store de perfis na camada global de `config.json` (#492): `providers`
 * e `models` de cada perfil, `activeProfileId`; chaves alheias sobrevivem.
 * Provider com modelos que saiu do store sai do arquivo; campos extras do
 * provider/modelo (timeoutMs, price, status…) são preservados.
 */
export function saveProfileStoreToConfig(store: ProviderStore, configPath: string): void {
  const valid = validateProfileStore(store);
  const raw = existsSync(configPath) ? loadConfigRaw(configPath) : {};
  // Camada atual inválida não é "consertada" por silêncio (ex.: modelo duplicado
  // faria a deleção abaixo apagar um provider editado à mão): falha sem gravar.
  assertLayerSchema(raw);
  // ADR-0028: config de um harness mais novo não é reescrita por um antigo.
  inspectConfigDocument(raw, { source: configPath });
  const providers: Record<string, unknown> = isPlainObject(raw.providers) ? { ...raw.providers } : {};
  const models: unknown[] = Array.isArray(raw.models) ? [...raw.models] : [];
  const storeIds = new Set(valid.profiles.map((profile) => profile.id));
  // Só modelo "visível para o store" (id/tags/context) conta como prova de que o
  // provider era do CRUD: um modelo editado à mão sem tags/context não autoriza
  // apagar o provider (#492, revisão).
  const modelProviders = new Set(
    models
      .filter((model): model is Record<string, unknown> => isPlainObject(model)
        && typeof model.provider === "string"
        && typeof model.id === "string"
        && Array.isArray(model.tags)
        && typeof model.context === "number")
      .map((model) => model.provider as string),
  );
  // Provider que tinha modelos e não está mais no store foi removido pela TUI.
  for (const id of Object.keys(providers)) {
    if (!storeIds.has(id) && modelProviders.has(id)) delete providers[id];
  }
  let nextModels = models.filter((model) => (
    !isPlainObject(model) || typeof model.provider !== "string" || providers[model.provider] !== undefined
  ));
  for (const profile of valid.profiles) {
    const existing = providers[profile.id];
    providers[profile.id] = { ...(isPlainObject(existing) ? existing : {}), ...profileToProvider(profile) };
    // Rótulo igual ao id volta a ser implícito: apaga o `name` antigo do merge.
    if (profile.name === profile.id && isPlainObject(providers[profile.id])) {
      delete (providers[profile.id] as Record<string, unknown>).name;
    }
    const wanted = new Set(profile.models.map((model) => model.id));
    nextModels = nextModels.filter((model) => (
      !isPlainObject(model) || model.provider !== profile.id || wanted.has(String(model.id))
    ));
    for (const model of profile.models) {
      const index = nextModels.findIndex((item) => (
        isPlainObject(item) && item.provider === profile.id && item.id === model.id
      ));
      const before = index >= 0 ? nextModels[index] : undefined;
      const entry = {
        ...(isPlainObject(before) ? before : {}),
        provider: profile.id,
        id: model.id,
        tags: model.tags,
        context: model.context,
      };
      if (index >= 0) nextModels[index] = entry;
      else nextModels.push(entry);
    }
  }
  const { activeProfileId: _previousActive, ...rest } = raw;
  const output = {
    ...rest,
    providers,
    models: nextModels,
    ...(valid.activeProfileId === undefined ? {} : { activeProfileId: valid.activeProfileId }),
  };
  assertLayerSchema(output); // a camada resultante tem de carregar no próximo open
  writeConfigRaw(output, configPath);
}

/**
 * Troca só `credentialRef` do provider na camada global de `config.json` (#491);
 * a escrita é atômica e valida a forma da camada.
 */
export function updateGlobalProviderCredentialRef(env: NodeJS.ProcessEnv, provider: string, ref: string): void {
  // Mesma regra do gêmeo de projeto: nunca um valor cru no arquivo (I-03).
  if (!isVaultCredentialRef(ref) && !isEnvName(ref)) {
    throw new ConfigError('credentialRef inválido: use "vault:<credentialId>" ou um nome de variável de ambiente', "config_invalid_schema");
  }
  const path = globalConfigPath(env);
  const raw = existsSync(path) ? loadConfigRaw(path) : {};
  const providers = isPlainObject(raw.providers) ? raw.providers : undefined;
  const entry = providers?.[provider];
  if (!isPlainObject(entry)) {
    throw new ConfigError(`provider "${provider}" não está no "${path}"`, "config_invalid_schema");
  }
  if (entry.kind !== "openai-compat") {
    throw new ConfigError(`provider "${provider}" usa kind "${String(entry.kind)}" e não lê o cofre`, "config_invalid_schema");
  }
  entry.credentialRef = ref;
  assertLayerSchema(raw);
  // ADR-0028: refusa config de harness mais novo antes de reescrever o arquivo.
  inspectConfigDocument(raw, { source: path });
  writeConfigRaw(raw, path);
}

/** Importa o store legado no `config.json`: `config.json` vence por chave (ADR-0029, #459). */
function importProfiles(configPath: string, legacy: ProviderStore): void {
  const raw = existsSync(configPath) ? loadConfigRaw(configPath) : {};
  const providers = { ...(isPlainObject(raw.providers) ? raw.providers : {}) };
  for (const profile of legacy.profiles) {
    if (!Object.hasOwn(providers, profile.id)) providers[profile.id] = profileToProvider(profile);
  }
  const imported = legacy.profiles.flatMap((profile) => (
    profile.models.map((model) => ({ provider: profile.id, id: model.id, tags: model.tags, context: model.context }))
  ));
  // Os modelos seguem por `provider/id` mesmo quando a chave do provider já existia:
  // no conflito, `config.json` vence a definição do provider; o conjunto de modelos
  // é unido (ADR-0029).
  const models = mergeModelLayers(imported, Array.isArray(raw.models) ? raw.models : []);
  writeConfigRaw({
    ...raw,
    providers,
    models,
    // D-21: a seleção ativa acompanha os perfis; a de `config.json` vence.
    ...(typeof raw.activeProfileId === "string" || legacy.activeProfileId === undefined
      ? {}
      : { activeProfileId: legacy.activeProfileId }),
  }, configPath);
}

/** Store efetivo a partir de `config.json`: `providers` + `models` viram perfis (sem nome próprio). */
export function profileStoreFromConfig(configPath: string): ProviderStore {
  if (!existsSync(configPath)) return { version: 1, profiles: [] };
  const raw = loadConfigRaw(configPath);
  const providers = isPlainObject(raw.providers) ? raw.providers : {};
  const models = Array.isArray(raw.models) ? raw.models : [];
  const profiles: ProviderProfile[] = [];
  for (const [id, value] of Object.entries(providers)) {
    if (!isPlainObject(value)) continue;
    const kind = value.kind;
    if (typeof kind !== "string") continue;
    const rawRef = typeof value.credentialRef === "string" ? value.credentialRef : undefined;
    // I-03: a config pode ter sido editada à mão; só referência nomeada ou do cofre
    // chega ao store. Valor cru (segredo colado) fica de fora, sem eco.
    const credentialRef = rawRef !== undefined && (isEnvName(rawRef) || isVaultCredentialRef(rawRef))
      ? rawRef
      : undefined;
    const headers: Record<string, string> = {};
    if (isPlainObject(value.headers)) {
      for (const [name, item] of Object.entries(value.headers)) {
        if (typeof item === "string") headers[name] = item;
      }
    }
    const profileModels = models.flatMap((model) => (
      isPlainObject(model) && model.provider === id && typeof model.id === "string"
        && Array.isArray(model.tags) && typeof model.context === "number"
        ? [{
            id: model.id,
            tags: model.tags.filter((tag): tag is string => typeof tag === "string"),
            context: model.context,
          }]
        : []
    ));
    // Perfil do store exige ao menos um modelo: sem modelo o provider não é selecionável.
    if (profileModels.length === 0) continue;
    profiles.push({
      id,
      name: typeof value.name === "string" && value.name !== "" ? value.name : id,
      kind,
      ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
      ...(credentialRef === undefined ? {} : { credentialRef }),
      ...(typeof value.credentialsPath === "string" ? { credentialsPath: value.credentialsPath } : {}),
      ...(typeof value.quotaDomain === "string" ? { quotaDomain: value.quotaDomain } : {}),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      models: profileModels,
    });
  }
  const activeProfileId = typeof raw.activeProfileId === "string" ? raw.activeProfileId : undefined;
  return { version: 1, ...(activeProfileId === undefined ? {} : { activeProfileId }), profiles };
}

/**
 * Store global efetivo (#459): depois de `migrations.providers`, a fonte é `config.json`
 * e o `providers.json` legado não é mais lido. `--no-global-config` desliga a camada.
 */
export function readGlobalProfileStore(env: NodeJS.ProcessEnv = process.env): ProviderStore {
  if (env.ASTRO_NO_GLOBAL_CONFIG === "1") return { version: 1, profiles: [] };
  const state = loadHomeState(statePath(env));
  if (!state.migrations.providers) return loadProfileStore(profilesPath(env));
  return profileStoreFromConfig(globalConfigPath(env));
}

/**
 * Store global com a migração única (ADR-0029, #459): na primeira carga com store legado
 * válido, importa os perfis para `config.json` e marca `migrations.providers`; a partir
 * daí delega para `readGlobalProfileStore`.
 */
export function loadGlobalProfileStore(env: NodeJS.ProcessEnv = process.env): ProviderStore {
  const legacyPath = profilesPath(env);
  const configPath = globalConfigPath(env);
  const stateFile = statePath(env);
  const state = loadHomeState(stateFile);
  if (state.migrations.providers) return readGlobalProfileStore(env);
  if (!existsSync(legacyPath)) {
    return existsSync(configPath) ? profileStoreFromConfig(configPath) : { version: 1, profiles: [] };
  }
  const legacy = loadProfileStore(legacyPath);
  // Sem perfis não há o que importar: não cria `config.json` (S3). A seleção sem
  // perfil é inútil e cai junto.
  if (legacy.profiles.length > 0) importProfiles(configPath, legacy);
  // Import e flag não são uma transação (`config.json` é gravado antes): se o processo
  // cair entre os dois, a próxima carga repete o import e `config.json` vence por chave.
  // A janela é aceita de propósito — repetir é idempotente.
  saveHomeState({ ...state, migrations: { ...state.migrations, providers: true } }, stateFile);
  return readGlobalProfileStore(env);
}

/** Valida antes de gravar; escrita atômica com modo 0600 no POSIX. */
export function saveProfileStore(store: ProviderStore, path: string = profilesPath()): void {
  const valid = validateProfileStore(store);
  if (loadHomeState(siblingPath(path, "state.json")).migrations.providers) {
    throw new ProfileStoreMigratedError(siblingPath(path, "config.json"));
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp já não existe */ }
    throw error;
  }
}

/** Camada global crua de `$ASTRO_HOME/config.json`; ausente = undefined. */
export function loadGlobalConfig(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | undefined {
  const path = globalConfigPath(env);
  if (!existsSync(path)) return undefined;
  return loadConfigRaw(path);
}

/**
 * ADR-0028: cada camada crua segue a própria `version`. Mais nova que o harness
 * falha fechada (`config_ahead_of_harness`, nomeando o arquivo) antes de
 * qualquer merge; uma camada antiga é migrada em memória, nunca no disco.
 */
function inspectLayerDocument(layer: Record<string, unknown>, source: string | undefined): Record<string, unknown> {
  return inspectConfigDocument(layer, { ...(source === undefined ? {} : { source }) }).document;
}

/**
 * Valida uma camada de projeto crua contra global+store (ADR-0029) e devolve a
 * config mesclada; sem gravar nada. Usada por `loadProjectConfig` e pela
 * pré-validação do `/config` antes de gravar (#558).
 */
export function validateProjectLayer(
  projectLayer: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  projectSource?: string,
): AstroConfig {
  const homeEnv = { ...process.env, ...env };
  const global = homeEnv.ASTRO_NO_GLOBAL_CONFIG === "1" ? undefined : loadGlobalConfig(homeEnv);
  // O schema de cada camada crua: `model` e `profile` não convivem e `models`
  // não se repete (a mescla entre camadas resolve o XOR, o conflito dentro da
  // camada é erro).
  assertLayerSchema(projectLayer);
  assertLayerSchema(global);
  // ADR-0028: versão e chaves são checadas por camada de origem, antes do merge.
  const projectDoc = inspectLayerDocument(projectLayer, projectSource);
  const globalDoc = global === undefined ? {} : inspectLayerDocument(global, globalConfigPath(homeEnv));
  const declared = mergeConfigLayers(globalDoc, projectDoc);
  // Todo model declarado aponta para um provider declarado nas camadas.
  assertDeclaredProviders(declared);
  // O store é fonte global de credenciais mesmo sem `$ASTRO_HOME/config.json`;
  // depois da migração a leitura vem de `config.json` (#459).
  const store = readGlobalProfileStore(homeEnv);
  const storeProviders = Object.fromEntries(store.profiles.map((profile) => [profile.id, profileToProvider(profile)]));
  assertNarrowed(globalDoc, declared, storeProviders, projectDoc);
  return validateConfig(declared);
}

/** Config do projeto mesclada com a camada global (validada); ausente = undefined.
 * `chat`/`tui` não validam o projeto isolado: ele pode depender do global. */
export function loadProjectConfig(configPath: string, opts: { env?: NodeJS.ProcessEnv } = {}): AstroConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  return validateProjectLayer(loadConfigRaw(configPath), opts.env ?? process.env, configPath);
}

export type ProviderSource = "project" | "global" | "env";

/** Quem escolheu o provider ativo (a definição pode vir de outro lugar). */
export type ProviderSelection = "flag" | "env" | "store" | "project";

export interface EffectiveConfig {
  config: AstroConfig;
  activeProvider: string;
  /** Origem da definição do provider ativo. */
  providerSource: ProviderSource;
  /** Origem da escolha do provider ativo. */
  providerSelection: ProviderSelection;
  /** Providers declarados no projeto (para atribuir a origem de modelos de agentes). */
  projectProviders: string[];
  /** Id do perfil efêmero de env, quando existe. */
  envProviderId?: string;
  warnings: string[];
}

/**
 * Origem de um provider qualquer (não só o ativo), para o audit não mentir quando
 * o modelo usado vem de agente nomeado, `opts.model` ou último modelo salvo.
 */
export function providerIdentityFor(
  effective: EffectiveConfig,
  provider: string,
): { providerSource: ProviderSource; providerSelection: ProviderSelection } {
  const providerSource: ProviderSource = effective.projectProviders.includes(provider)
    ? "project"
    : provider === effective.envProviderId
      ? "env"
      : "global";
  if (provider === effective.activeProvider) {
    return { providerSource, providerSelection: effective.providerSelection };
  }
  const providerSelection: ProviderSelection = providerSource === "project"
    ? "project"
    : providerSource === "env"
      ? "env"
      : "store";
  return { providerSource, providerSelection };
}

/** Sem config, expõe file tools + shell; a allowlist segue I-01 e o gate `ask` (D-24). */
const ENV_MODEL_CONTEXT = 128_000;

/** Conjunto de variáveis por provider builtin (S6, #472): `ASTRO_PROVIDER` é o único seletor. */
interface EnvProviderSpec {
  /** Id do perfil efêmero; é o nome aceito por `ASTRO_PROVIDER`. */
  id: string;
  label: string;
  /** Prefixo das variáveis, só para mensagens — nunca o valor. */
  prefix: string;
  keyVar: string;
  modelVar: string;
  baseUrlVar: string;
  defaultBaseUrl: string;
}

const ENV_PROVIDERS: readonly EnvProviderSpec[] = [
  { id: "openai", label: "OpenAI (env)", prefix: "OPENAI", keyVar: "OPENAI_API_KEY", modelVar: "OPENAI_MODEL", baseUrlVar: "OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com/v1" },
  { id: "nvidia", label: "NVIDIA NIM (env)", prefix: "NVIDIA", keyVar: "NVIDIA_API_KEY", modelVar: "NVIDIA_MODEL", baseUrlVar: "NVIDIA_BASE_URL", defaultBaseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "openrouter", label: "OpenRouter (env)", prefix: "OPENROUTER", keyVar: "OPENROUTER_API_KEY", modelVar: "OPENROUTER_MODEL", baseUrlVar: "OPENROUTER_BASE_URL", defaultBaseUrl: "https://openrouter.ai/api/v1" },
];

/** Variável vazia (ou só espaços) é ausente. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Variáveis que faltam para o conjunto ficar completo (chave + modelo). */
function missingEnvVars(spec: EnvProviderSpec, env: NodeJS.ProcessEnv): string[] {
  return [spec.keyVar, spec.modelVar].filter((name) => envValue(env, name) === undefined);
}

/** Seletor único do ambiente; sem ele, nenhum conjunto é escolhido implicitamente. */
export function envProviderSelector(env: NodeJS.ProcessEnv): string | undefined {
  return envValue(env, "ASTRO_PROVIDER");
}

/** Seleção por ambiente inválida (#472). Configuração, não falha de provider (D-18). */
export type ProviderEnvErrorCode =
  | "provider_env_ambiguous"
  | "provider_env_incomplete"
  | "provider_env_insecure_url"
  | "provider_env_collision"
  | "provider_unknown";

export class ProviderEnvError extends Error {
  override name = "ProviderEnvError";
  constructor(readonly code: ProviderEnvErrorCode, message: string) {
    super(message);
  }
}

/** Ids reservados para o perfil efêmero: `add`/`edit` não podem criá-los (#472). */
export const ENV_PROVIDER_IDS: readonly string[] = ENV_PROVIDERS.map((spec) => spec.id);

/** O conjunto do ambiente para `id` está em uso (chave ou modelo presente). */
export function envProviderClaimed(id: string, env: NodeJS.ProcessEnv): boolean {
  const spec = envProviderSpec(id);
  return spec !== undefined && (envValue(env, spec.keyVar) !== undefined || envValue(env, spec.modelVar) !== undefined);
}

/** Modelo `provider/id` escolhido pelas camadas (`agent.model` ou o do `agent.profile`). */
function layerModelRef(layers: Record<string, unknown>): string | undefined {
  const agent = isPlainObject(layers.agent) ? layers.agent : {};
  if (typeof agent.model === "string") return agent.model;
  const profileName = typeof agent.profile === "string" ? agent.profile : undefined;
  const pool = profileName === undefined || !isPlainObject(layers.modelPool) ? undefined : layers.modelPool[profileName];
  return isPlainObject(pool) && typeof pool.model === "string" ? pool.model : undefined;
}

/**
 * O ambiente só é fonte quando nem as camadas nem o store escolhem provider +
 * modelo (#472). Sem isso, variáveis exportadas na máquina quebrariam um
 * projeto que já resolve o próprio provider (`provider_env_ambiguous`).
 */
export function envProviderAllowed(input: {
  project?: unknown;
  global?: unknown;
  store: ProviderStore;
}): boolean {
  const project = isPlainObject(input.project) ? input.project : {};
  const global = isPlainObject(input.global) ? input.global : {};
  const declared = mergeConfigLayers(global, project);
  const providers = isPlainObject(declared.providers) ? declared.providers : {};
  const modelRef = layerModelRef(declared);
  if (modelRef !== undefined && providerOfModel(modelRef, providers) !== undefined) return false;
  return input.store.profiles.length === 0;
}

/** Defaults de código: a camada mais baixa (defaults < global < projeto, ADR-0029). */
const BASELINE_LAYER: Record<string, unknown> = {
  agent: { maxSteps: BASELINE_MAX_STEPS, tools: [...DEFAULT_AGENT_TOOLS] },
  permissions: { mode: "ask" },
  attachments: DEFAULT_ATTACHMENTS,
  paths: { ...DEFAULT_PATHS },
};

/**
 * Perfil efêmero do ambiente; nunca é gravado (#472).
 *
 * Regra: `ASTRO_PROVIDER` escolhe o conjunto (`openai`, `nvidia`, `openrouter`);
 * sem ele, exatamente um conjunto completo (chave + modelo) é usado e mais de um
 * é erro de ambiguidade. Conjunto parcial nunca seleciona e as variáveis de um
 * provider nunca selecionam outro. O chamador decide antes se o ambiente entra
 * (`envProviderAllowed`): o erro de ambiguidade só vale quando ele é a fonte.
 */
export function profileFromEnv(env: NodeJS.ProcessEnv): ProviderProfile | undefined {
  const complete = ENV_PROVIDERS.filter((spec) => missingEnvVars(spec, env).length === 0);
  const selector = envProviderSelector(env);
  let spec: EnvProviderSpec | undefined;
  if (selector === undefined) {
    if (complete.length > 1) {
      const sets = complete.map((item) => `${item.prefix}_* (${item.id})`).join(" e ");
      throw new ProviderEnvError(
        "provider_env_ambiguous",
        `ambiente ambíguo: ${sets} definem providers completos; defina ASTRO_PROVIDER para escolher`,
      );
    }
    spec = complete[0];
  } else {
    // Seleção explícita: conjunto incompleto não é substituído pelo vizinho.
    spec = complete.find((item) => item.id === selector);
  }
  if (spec === undefined) return undefined;
  const profile: ProviderProfile = {
    id: spec.id,
    name: spec.label,
    kind: "openai-compat",
    baseUrl: envValue(env, spec.baseUrlVar) ?? spec.defaultBaseUrl,
    credentialRef: spec.keyVar,
    models: [{ id: envValue(env, spec.modelVar)!, tags: [], context: ENV_MODEL_CONTEXT }],
  };
  // Mesmo validador do store: rejeita URL com credencial embutida, etc.
  const valid = validateProfileStore({ version: 1, profiles: [profile] }).profiles[0]!;
  // http:// só depois de confirmação explícita; https:// passa direto.
  if (new URL(valid.baseUrl!).protocol === "http:" && envValue(env, "ASTRO_ALLOW_INSECURE_BASE_URL") !== "1") {
    throw new ProviderEnvError(
      "provider_env_insecure_url",
      `${spec.baseUrlVar} usa http:// (sem TLS); confirme com ASTRO_ALLOW_INSECURE_BASE_URL=1 ou use https://`,
    );
  }
  return valid;
}

/** `ASTRO_PROVIDER` sem provider correspondente: erro tipado com os nomes conhecidos. */
function unknownEnvProvider(requested: string, known: string[]): ProviderEnvError {
  const names = [...new Set(known)].sort();
  return new ProviderEnvError(
    "provider_unknown",
    `ASTRO_PROVIDER="${requested}" não corresponde a nenhum provider conhecido; conhecidos: ${names.length === 0 ? "nenhum" : names.join(", ")} · defina OPENAI_*, NVIDIA_* ou OPENROUTER_* no ambiente ou use /provider add`,
  );
}

/** Conjunto completo nomeado pelo seletor: seleção explícita mesmo com config resolvida. */
function envProviderSpec(id: string): EnvProviderSpec | undefined {
  return ENV_PROVIDERS.find((item) => item.id === id);
}

function selectorSetComplete(selector: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (selector === undefined) return false;
  const spec = envProviderSpec(selector);
  return spec !== undefined && missingEnvVars(spec, env).length === 0;
}

function profileToProvider(profile: ProviderProfile): ProviderConfig {
  // `name` só entra quando difere do id (rótulo de exibição do CRUD, #492).
  const label = profile.name === profile.id ? {} : { name: profile.name };
  if (profile.kind === "codex-oauth") {
    return {
      ...label,
      kind: "codex-oauth",
      credentialsPath: profile.credentialsPath ?? "~/.codex/auth.json",
      ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
      ...(profile.headers === undefined ? {} : { headers: profile.headers }),
      ...(profile.quotaDomain === undefined ? {} : { quotaDomain: profile.quotaDomain }),
    };
  }
  return {
    ...label,
    kind: profile.kind,
    baseUrl: profile.baseUrl ?? "",
    ...(profile.credentialRef === undefined ? {} : { credentialRef: profile.credentialRef }),
    ...(profile.headers === undefined ? {} : { headers: profile.headers }),
    ...(profile.quotaDomain === undefined ? {} : { quotaDomain: profile.quotaDomain }),
  };
}

function providerOfModel(modelRef: string, providers: Record<string, unknown>): string | undefined {
  return Object.keys(providers)
    .sort((a, b) => b.length - a.length)
    .find((name) => modelRef.startsWith(`${name}/`));
}

/** Estado inicial sem nenhum provider: a TUI abre a tela de providers. */
export class NoProviderError extends Error {
  override name = "NoProviderError";
}

export const NO_PROVIDER_MESSAGE =
  "nenhum provider configurado: rode /provider add ou defina um conjunto de ambiente (OPENAI_*, NVIDIA_* ou OPENROUTER_*, com a chave e o modelo)";

/**
 * Provider sintético do diagnóstico (#523): quando não há provider, ele permite
 * validar a config efetiva por inteiro em vez de mascarar uma camada inválida
 * com `NoProviderError`. Nunca entra no store nem na saída do doctor.
 */
const DIAGNOSTIC_FALLBACK_PROFILE: ProviderProfile = {
  id: "astro-doctor-probe",
  name: "Astro doctor probe",
  kind: "openai-compat",
  baseUrl: "https://doctor-probe.invalid/v1",
  models: [{ id: "probe", tags: [], context: 1024 }],
};

/** Mescla a camada global com o projeto e resolve o provider ativo. */
export function resolveEffectiveConfig(input: {
  /** Camada de projeto: JSON cru do arquivo ou config já validada. */
  project?: unknown;
  /** Camada global (`$ASTRO_HOME/config.json`), JSON cru e parcial. */
  global?: unknown;
  store: ProviderStore;
  envProfile?: ProviderProfile;
  providerFlag?: string;
  env?: NodeJS.ProcessEnv;
  /** Resume/replay: não trocar provider por store/env sem pedido explícito. */
  ignoreStoredSelection?: boolean;
  /**
   * Perfil sintético de diagnóstico: quando nenhum provider existe, a config
   * efetiva é validada com ele em vez de mascarar camadas inválidas (#523).
   */
  diagnosticFallback?: ProviderProfile;
  /** Arquivo da camada de projeto, só para nomear a recusa de schema (ADR-0028). */
  projectPath?: string;
}): EffectiveConfig {
  const env = input.env ?? process.env;
  const warnings: string[] = [];
  // Cofre em modo plain (fora do Windows) com credenciais avisa explícito (ADR-0019, #311)
  try {
    const vaultWarn = vaultPlainWarning(vaultMeta(vaultPath(env), process.platform));
    if (vaultWarn !== undefined) warnings.push(vaultWarn);
  } catch {
    // cofre ilegível não quebra o start da sessão; `astro health` reporta o detalhe
  }
  const project = isPlainObject(input.project)
    ? inspectLayerDocument(input.project, input.projectPath)
    : undefined;
  const global = isPlainObject(input.global)
    ? inspectLayerDocument(input.global, globalConfigPath({ ...process.env, ...env }))
    : undefined;
  // ADR-0029: defaults < global < projeto; a validação do merge decide o que é seguro.
  const declared = mergeConfigLayers(global ?? {}, project ?? {});
  const base = project === undefined ? mergeConfigLayers(BASELINE_LAYER, declared) : declared;
  const selector = envProviderSelector(env);
  const layerProviders = isPlainObject(base.providers) ? base.providers : {};
  // #472: o ambiente é fallback. Só entra quando nem as camadas nem o store
  // resolvem provider + modelo, ou quando `ASTRO_PROVIDER` nomeia um conjunto completo.
  const envProfile = input.envProfile ?? (
    envProviderAllowed({ project: declared, store: input.store }) || selectorSetComplete(selector, env)
      ? profileFromEnv(env)
      : undefined
  );
  const profiles = new Map(input.store.profiles.map((profile) => [profile.id, profile]));
  let envInjected = false;
  if (envProfile !== undefined) {
    const id = envProfile.id;
    if (profiles.has(id)) {
      // O ambiente preenche só id ausente; perfil salvo vence (#472, revisão).
      warnings.push(`perfil salvo "${id}" foi ignorado nesta sessão; conjunto de ambiente não foi aplicado`);
    } else if (Object.hasOwn(layerProviders, id)) {
      // Provider declarado numa camada vence; injetar o modelo do ambiente
      // mandaria um modelo para o endpoint/credencial de outro provider (#472).
      if (selector === id) {
        throw new ProviderEnvError(
          "provider_env_collision",
          `ASTRO_PROVIDER="${id}" conflita com o provider "${id}" declarado na configuração; remova o conjunto ${envProviderSpec(id)?.prefix ?? id}_* ou o provider declarado`,
        );
      }
    } else {
      profiles.set(id, envProfile);
      envInjected = true;
    }
  }

  const globalProviders: Record<string, ProviderConfig> = {};
  const globalModels: ModelConfig[] = [];
  for (const profile of profiles.values()) {
    globalProviders[profile.id] = profileToProvider(profile);
    for (const model of profile.models) {
      globalModels.push({ provider: profile.id, id: model.id, tags: model.tags, context: model.context });
    }
  }
  // O estreitamento olha a camada global e o store: a credencial global não
  // muda de endpoint. O store vale mesmo sem `$ASTRO_HOME/config.json`. O perfil
  // efêmero de env não entra: ele é por execução e a escolha do usuário não
  // é um bloqueio do projeto.
  const storeProviders = Object.fromEntries(input.store.profiles.map((profile) => [profile.id, profileToProvider(profile)]));
  assertNarrowed(global ?? {}, declared, storeProviders, project);

  const providers: Record<string, unknown> = { ...globalProviders, ...(isPlainObject(base.providers) ? base.providers : {}) };
  const models = mergeModelLayers(globalModels, Array.isArray(base.models) ? base.models : []);
  const agent = isPlainObject(base.agent) ? base.agent : {};
  const profileName = typeof agent.profile === "string" ? agent.profile : undefined;
  const poolEntry = profileName === undefined ? undefined : (isPlainObject(base.modelPool) ? base.modelPool[profileName] : undefined);
  // Na pool (F-27), o profile substitui `agent.model`.
  const poolModel = isPlainObject(poolEntry) && typeof poolEntry.model === "string" ? poolEntry.model : undefined;
  const declaredModel = typeof agent.model === "string" ? agent.model : poolModel;
  const projectProvider = declaredModel === undefined ? undefined : providerOfModel(declaredModel, providers);

  let requested: string | undefined;
  let requestKind: ProviderSelection | undefined;
  // `ASTRO_PROVIDER` é validado sempre, inclusive com `--provider` (#472, revisão).
  if (selector !== undefined) {
    const spec = envProviderSpec(selector);
    const missing = spec === undefined ? [] : missingEnvVars(spec, env);
    if (spec === undefined) {
      if (!Object.hasOwn(providers, selector)) {
        throw unknownEnvProvider(selector, [...Object.keys(providers), ...ENV_PROVIDER_IDS]);
      }
    } else if (missing.length > 0) {
      if (Object.hasOwn(providers, selector)) {
        // Conjunto incompleto não é erro quando há provider configurado com o nome.
        warnings.push(
          `ASTRO_PROVIDER="${selector}" aponta para o conjunto ${spec.prefix}_* incompleto (falta ${missing.join(", ")}); usando o provider configurado "${selector}"`,
        );
      } else {
        throw new ProviderEnvError(
          "provider_env_incomplete",
          `ASTRO_PROVIDER="${selector}" aponta para o conjunto ${spec.prefix}_* incompleto: falta ${missing.join(", ")}`,
        );
      }
    }
  }
  if (input.providerFlag !== undefined) { requested = input.providerFlag; requestKind = "flag"; }
  else if (!input.ignoreStoredSelection && selector !== undefined) {
    requested = selector;
    requestKind = "env";
  } else if (!input.ignoreStoredSelection && input.store.activeProfileId !== undefined) {
    requested = input.store.activeProfileId;
    requestKind = "store";
  }

  const pooled = profileName !== undefined;
  if (pooled) {
    if (requested !== undefined && requested !== projectProvider) {
      if (requestKind === "flag") {
        throw new Error(`provider "${requested}" não pode ser aplicado: agent.profile tem precedência`);
      }
      warnings.push("agent.profile tem precedência sobre a troca de provider");
    }
    requested = undefined;
    requestKind = undefined;
  }

  let activeProvider: string | undefined;
  let selection: ProviderSelection = "project";
  if (requested !== undefined) {
    if (Object.hasOwn(providers, requested)) {
      activeProvider = requested;
      selection = requestKind ?? "project";
    } else if (requestKind === "store") {
      warnings.push(`activeProfileId "${requested}" não corresponde a nenhum perfil; seleção ignorada`);
    } else if (requestKind === "env") {
      // #472: seletor desconhecido é erro tipado, nunca fallback silencioso.
      throw unknownEnvProvider(requested, Object.keys(providers));
    } else {
      throw new Error(`provider "${requested}" não está configurado`);
    }
  }
  if (activeProvider === undefined) {
    if (projectProvider !== undefined) { activeProvider = projectProvider; selection = "project"; }
    else if (envProfile !== undefined) { activeProvider = envProfile.id; selection = "env"; }
    else if (input.store.profiles[0] !== undefined) { activeProvider = input.store.profiles[0].id; selection = "store"; }
    else {
      // Sem provider em lugar nenhum: o erro de schema vem primeiro (como em
      // `origin/main`), senão a mensagem aponta para a correção errada
      // ("/provider add") em vez de apontar o campo inválido.
      if (project !== undefined) validateConfig(declared);
      const fallback = input.diagnosticFallback;
      if (fallback === undefined) throw new NoProviderError(NO_PROVIDER_MESSAGE);
      // Diagnóstico: o provider sintético entra só na validação da config
      // efetiva; assim uma camada inválida não fica mascarada por
      // `NoProviderError` (#523). Ele não é gravado nem exibido.
      activeProvider = fallback.id;
      selection = "store";
      providers[fallback.id] = profileToProvider(fallback);
      for (const model of fallback.models) {
        models.push({ provider: fallback.id, id: model.id, tags: model.tags, context: model.context });
      }
    }
  }

  const currentProvider = projectProvider;
  let modelRef: string;
  if (declaredModel !== undefined && (pooled || currentProvider === activeProvider)) {
    modelRef = declaredModel;
  } else {
    const currentId = currentProvider === undefined ? undefined : declaredModel?.slice(currentProvider.length + 1);
    const candidates = (models as { provider?: unknown; id?: unknown; status?: unknown }[]).filter(
      (model) => model.provider === activeProvider && (model.status ?? "active") === "active",
    );
    const kept = currentId === undefined ? undefined : candidates.find((model) => model.id === currentId);
    const chosen = kept ?? candidates[0];
    if (chosen === undefined) throw new Error(`provider "${activeProvider}" não tem modelo ativo`);
    modelRef = `${String(chosen.provider)}/${String(chosen.id)}`;
  }

  // O aviso de baseline só vale quando as tools padrão e o modo `ask` estão em uso.
  const baselineTools = !isPlainObject(declared.agent) || declared.agent.tools === undefined;
  if (project === undefined && baselineTools && isPlainObject(base.permissions) && base.permissions.mode === "ask") {
    warnings.push(
      "sem astro.config.json: usando tools padrão; escrita e shell pedem aprovação",
    );
  }

  const { model: _declaredModel, ...agentSansModel } = agent;
  // `validateConfig` devolve agents com `model` resolvido + `profile`; revalidar os dois falha.
  const agentsSansModel = !isPlainObject(base.agents)
    ? undefined
    : Object.fromEntries(Object.entries(base.agents).map(([name, entry]) => {
        if (!isPlainObject(entry) || entry.profile === undefined) return [name, entry];
        const { model: _resolved, ...rest } = entry;
        return [name, rest];
      }));
  const config = validateConfig({
    ...base,
    providers,
    models,
    agent: pooled ? agentSansModel : { ...agent, model: modelRef },
    ...(agentsSansModel === undefined ? {} : { agents: agentsSansModel }),
  });
  const projectProviders = project === undefined ? [] : Object.keys(isPlainObject(project.providers) ? project.providers : {});
  const providerSource: ProviderSource = projectProviders.includes(activeProvider)
    ? "project"
    : envInjected && activeProvider === envProfile?.id
      ? "env"
      : "global";

  return {
    config,
    activeProvider,
    providerSource,
    providerSelection: selection,
    projectProviders,
    ...(envInjected && envProfile !== undefined ? { envProviderId: envProfile.id } : {}),
    warnings,
  };
}

/** Carrega o projeto, o store global e o perfil de env, e resolve. */
export function loadEffectiveConfig(
  configPath: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    provider?: string;
    storePath?: string;
    allowMissing?: boolean;
    ignoreStoredSelection?: boolean;
    /** Ignora a camada global (`--no-global-config`). */
    noGlobalConfig?: boolean;
    /**
     * Diagnóstico: sem provider, valida a config efetiva com um provider
     * sintético em vez de mascarar camadas inválidas (#523).
     */
    diagnosticFallbackProvider?: boolean;
  } = {},
): EffectiveConfig {
  const env = opts.env ?? process.env;
  // Os artefatos do home (config global e store) usam o env do processo: um env
  // parcial de execução não realoca o `~/.astro`. A camada global vale mesmo
  // com `--config` explícito; só as duas flags (e o env) a desligam (ADR-0029).
  const homeEnv = { ...process.env, ...opts.env };
  const useGlobal = homeEnv.ASTRO_NO_GLOBAL_CONFIG !== "1" && opts.noGlobalConfig !== true;
  const exists = existsSync(configPath);
  if (!exists && opts.allowMissing !== true) {
    throw new ConfigError(`configuração não encontrada: "${configPath}"`);
  }
  const project = exists ? loadConfigRaw(configPath) : undefined;
  const global = useGlobal ? loadGlobalConfig(homeEnv) : undefined;
  // O schema de cada camada crua: `model` e `profile` não convivem e `models`
  // não se repete (a mescla entre camadas resolve o XOR, o conflito dentro da
  // camada é erro).
  assertLayerSchema(project);
  assertLayerSchema(global);
  const merged = mergeConfigLayers(global ?? {}, project ?? {});
  // Todo model declarado aponta para um provider declarado nas camadas.
  assertDeclaredProviders(merged);
  // O `agent.model` declarado precisa existir nas camadas (global + projeto):
  // sem esta checagem, um modelo inexistente seria trocado em silêncio pelo
  // modelo resolvido (store/env).
  const declaredAgent = isPlainObject(merged.agent) ? merged.agent : {};
  const declaredModels = Array.isArray(merged.models) ? merged.models : [];
  if (typeof declaredAgent.model === "string"
    && !declaredModels.some((model) => isPlainObject(model) && `${String(model.provider)}/${String(model.id)}` === declaredAgent.model)) {
    throw new ConfigError(`config inválida: "agent.model" referencia o modelo "${declaredAgent.model}", que não está declarado em "models"`);
  }
  // Store legado só é lido com store injetado ou antes da migração; depois dela a
  // fonte é `config.json` e o legado aposentado nunca mais é lido (#459). Sem a
  // camada global (`--no-global-config` via env ou opção) o store também é omitido.
  const store = opts.storePath !== undefined
    ? loadProfileStore(opts.storePath)
    : useGlobal
      ? loadGlobalProfileStore(homeEnv)
      : readGlobalProfileStore({ ...homeEnv, ASTRO_NO_GLOBAL_CONFIG: "1" });
  // O perfil de ambiente é resolvido lá dentro (#472): só entra quando as
  // camadas e o store não resolvem provider + modelo, ou por seleção explícita.
  return resolveEffectiveConfig({
    ...(project === undefined ? {} : { project }),
    ...(global === undefined ? {} : { global }),
    projectPath: configPath,
    store,
    ...(opts.provider === undefined ? {} : { providerFlag: opts.provider }),
    ...(opts.ignoreStoredSelection === true ? { ignoreStoredSelection: true } : {}),
    ...(opts.diagnosticFallbackProvider === true ? { diagnosticFallback: DIAGNOSTIC_FALLBACK_PROFILE } : {}),
    env,
  });
}
