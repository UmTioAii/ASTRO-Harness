/** Bootstrap da TUI: Ink é carregado por import dinâmico só neste comando. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ConfigError } from "../core/config";
import { ProfileManager } from "../providers/profile-manager";
import { NoProviderError, NO_PROVIDER_MESSAGE, loadEffectiveConfig, loadProjectConfig, projectLayerRefs } from "../providers/profiles";
import { redactSecrets } from "../sanitize-external";
import { runSetup, ttySetupIO } from "../chat/setup";
import { ensureShellConsent, SHELL_CONSENT_DECLINED_NOTICE, ttyShellConsentAsk, type ShellConsentAsk } from "../shell-consent";
import { ensureTermsAccepted, ttyTermsAsk, type TermsAsk } from "../terms";
import { setShellConsent } from "../tools/run-command";
import { trustChoice, trustPrompt } from "../trust";
import { Vault, vaultPath } from "../vault";
import { probeActiveCredential, recoverActiveCredential, writeRecoveredCredentialRef } from "./credential-boot";
import { createSecretHandlers } from "./vault-secret";
import { createApprovalBridge } from "./approvals";
import { createShellRunner, type ShellRunner } from "./shell";
import { getThemeColors, loadTuiConfig } from "./theme";
import { projectDataDir } from "../home-layout";
import { astroHomePath, statePath } from "../astro-home";

export interface RunTuiOptions {
  configPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  provider?: string;
  allowMissingConfig?: boolean;
  /** `allow-critical` da CLI (ADR-0027 slice 5a): vai à sessão e ao shell `!cmd`. */
  allowCritical?: readonly string[];
  /** `allow-sensitive` da CLI (ADR-0027): promove normal para sensitive no gate/read_file. */
  allowSensitive?: readonly string[];
  /** `--artifact-root` (ADR-0026): raiz do artifact store de imagens; ausente usa env/default. */
  artifactRoot?: string;
}

/** Ink desmontaria no ctrl+c antes do handler da app; a app decide a saída. */
export const TUI_RENDER_OPTIONS = { exitOnCtrlC: false } as const;

/**
 * Abre a sessão já com o último modelo salvo — mas só quando a config não
 * declara `agent.model` (#497, I-08): o modelo do projeto nunca é trocado em
 * silêncio. Modelo salvo removido/inválido cai no default.
 */
export function openSession<T>(create: (model?: string) => T, cwd: string, declaredModel?: string): T {
  // Modelo declarado em qualquer camada vence o estado de UI (I-08); checa antes de ler o disco.
  if (declaredModel !== undefined) return create();
  const saved = loadTuiConfig(cwd).lastModel;
  if (saved === undefined) return create();
  try {
    return create(saved);
  } catch (error) {
    if (error instanceof ConfigError) return create();
    throw error;
  }
}

/**
 * `agent.model` efetivo (global + projeto, com profile resolvido) — a mesma
 * resolução da sessão. Sem config legível, `undefined` e o boot segue o fluxo
 * normal (setup de provider, se for o caso).
 */
export function declaredModelFor(
  configPath: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  try {
    return loadEffectiveConfig(configPath, { env: opts.env, allowMissing: true }).config.agent.model;
  } catch {
    return undefined;
  }
}

/** Decisão de boot da TUI (#497): `--provider` e `agent.model` declarado desligam o modelo salvo. */
export function bootSession<T>(
  create: (model?: string) => T,
  cwd: string,
  opts: { declaredModel?: string; provider?: string },
): T {
  if (opts.provider !== undefined) return create();
  return openSession(create, cwd, opts.declaredModel);
}

/** Branch git do cwd; ausente fora de um repositório. */
export function gitBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" || out === "HEAD" ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * Primeiro run: tenta criar a sessão. Só quando falta provider e a config é
 * implícita abre o setup; qualquer outro erro segue o caminho normal.
 */
export async function withProviderSetup<T>(
  create: () => T,
  setup: () => Promise<boolean>,
  allowMissingConfig: boolean,
): Promise<T | undefined> {
  try {
    return create();
  } catch (error) {
    if (!allowMissingConfig || !(error instanceof NoProviderError)) throw error;
    if (!(await setup())) return undefined;
    return create();
  }
}

/** Portão dos termos da TUI (#479), antes de qualquer escrita (config, sessão, estado). */
export type TuiTermsBoot =
  /** Recusou: nada foi criado nem gravado. */
  | { kind: "declined" }
  /** Sem canal interativo: segue sem perguntar e sem registrar aceite. */
  | { kind: "unattended" }
  /** Versão corrente já aceita ou aceita agora; o boot pode seguir. */
  | { kind: "ready" };

export interface BootTuiTermsOptions {
  /** `$ASTRO_HOME` de onde sai o `state.json`; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Caminho do `state.json` (teste); default `statePath(env)`. */
  path?: string;
  /** Canal interativo; ausente = sem TTY (não pergunta, não grava). */
  ask?: TermsAsk;
  /** Canal do consentimento de risco do shell (#599); ausente = sem TTY. */
  shellAsk?: ShellConsentAsk;
  /** Relógio do teste; default `new Date()`. */
  now?: () => Date;
}

/**
 * Espelha o `bootChat`: o portão dos termos roda antes de `ensureFirstRun`, da
 * config e da sessão, e a recusa sai sem gravar nada. #599: o consentimento de
 * risco do shell é pedido logo depois, e recusá-lo desliga o shell da sessão.
 */
export async function bootTuiTerms(opts: BootTuiTermsOptions = {}): Promise<TuiTermsBoot> {
  const path = opts.path ?? statePath(opts.env ?? process.env);
  const decision = await ensureTermsAccepted({
    path,
    ...(opts.ask === undefined ? {} : { ask: opts.ask }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  if (decision.kind === "declined") return { kind: "declined" };
  const shell = await ensureShellConsent({
    path,
    ...(opts.shellAsk === undefined ? {} : { ask: opts.shellAsk }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  if (shell.kind === "declined") console.error(SHELL_CONSENT_DECLINED_NOTICE);
  setShellConsent(shell.kind === "declined" ? "declined" : shell.kind === "unattended" ? "unrecorded" : "accepted");
  return decision.kind === "unattended" ? { kind: "unattended" } : { kind: "ready" };
}

export interface TuiBootstrapOptions<T> {
  createSession(): T;
  setup(): Promise<boolean>;
  createShell(): ShellRunner;
  allowMissingConfig: boolean;
}

export interface TuiBootstrap<T> {
  session: T;
  shell: ShellRunner;
}

/**
 * Bootstrap testável da TUI: sessão e shell só são criados depois que o
 * provider existe. O shell carrega a config efetiva, então criá-lo antes do
 * setup escondia a tela de providers (#348).
 */
export async function bootstrapTui<T>(opts: TuiBootstrapOptions<T>): Promise<TuiBootstrap<T> | undefined> {
  return await withProviderSetup(
    () => ({ session: opts.createSession(), shell: opts.createShell() }),
    opts.setup,
    opts.allowMissingConfig,
  );
}

/** Tela de providers standalone; resolve true quando um perfil foi ativado. */
export async function setupProvider(
  manager: ProfileManager,
  cwd: string,
  onSaveSecret?: (providerId: string, secret: string) => string,
  onDiscardSecret?: (ref: string) => void,
  /** #616: boot recovery opens the credential step of the saved provider. */
  opts: {
    initial?: { mode: "list" | "add" | "edit" | "remove" | "credential"; target?: string };
    onCredentialRef?: (providerId: string, ref: string) => void;
  } = {},
): Promise<boolean> {
  const [{ render }, { ProviderScreen }] = await Promise.all([
    import("ink"),
    import("./provider-screen"),
  ]);
  const colors = getThemeColors(loadTuiConfig(cwd).theme);
  return await new Promise<boolean>((resolveSetup) => {
    let instance: ReturnType<typeof render> | undefined;
    let settled = false;
    const finish = (configured: boolean): void => {
      if (settled) return;
      settled = true;
      instance?.unmount();
      resolveSetup(configured);
    };
    instance = render(
      <ProviderScreen
        manager={manager}
        colors={colors}
        onClose={() => finish(false)}
        onActivate={() => finish(true)}
        onChanged={() => undefined}
        {...(opts.initial === undefined ? {} : { initial: opts.initial })}
        {...(opts.onCredentialRef === undefined ? {} : { onCredentialRef: opts.onCredentialRef })}
        {...(onSaveSecret === undefined ? {} : { onSaveSecret })}
        {...(onDiscardSecret === undefined ? {} : { onDiscardSecret })}
      />,
      TUI_RENDER_OPTIONS,
    );
  });
}

export async function runTui(opts: RunTuiOptions): Promise<number> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    console.error("erro: astro precisa de um terminal interativo; use `astro chat` para stdin em pipe");
    return 1;
  }
  try {
    // #479: termos de uso antes de qualquer escrita (config, sessão, estado).
    const terms = await bootTuiTerms({
      env: opts.env ?? process.env, ask: ttyTermsAsk(), shellAsk: ttyShellConsentAsk(),
    });
    if (terms.kind === "declined") {
      console.error("termos de uso não aceitos — saindo sem gravar nada");
      return 1;
    }
    const configPath = resolve(opts.configPath);
    // #611: the wizard owns first-run and runs at the terms gate, before any read of the config.
    const setupChannel = ttySetupIO();
    try {
      const outcome = await runSetup(configPath, {
        env: opts.env ?? process.env,
        allowMissing: opts.allowMissingConfig === true,
        io: setupChannel.io,
      });
      if (outcome.notice !== undefined) console.error(`aviso: ${redactSecrets(outcome.notice)}`);
    } catch (error) {
      console.error(`aviso: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    } finally {
      setupChannel.close();
    }
    const [{ render }, { AgentSession }, { openSessionApi }, { TuiApp }] = await Promise.all([
      import("ink"),
      import("../chat/agent-session"),
      import("../chat/session-api"),
      import("./app"),
    ]);
    const cwd = resolve(opts.cwd);
    const approvals = createApprovalBridge();
    // Chave digitada no setup vai para o cofre (ADR-0019); o perfil guarda só o ref.
    const vault = new Vault(vaultPath(opts.env ?? process.env));
    const { saveSecret, discardSecret } = createSecretHandlers(vault);
    const project = loadProjectConfig(configPath, { env: opts.env });
    const manager = new ProfileManager({
      project,
      projectRefs: projectLayerRefs(configPath),
      env: opts.env ?? process.env,
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    });
    // #616: a saved provider whose credential no longer resolves gets the credential step before the chat opens.
    const credential = await recoverActiveCredential({
      probe: () => probeActiveCredential({
        configPath,
        env: opts.env ?? process.env,
        vault,
        allowMissing: opts.allowMissingConfig === true,
        ...(opts.provider === undefined ? {} : { provider: opts.provider }),
      }),
      recover: (missing) => setupProvider(manager, cwd, saveSecret, discardSecret, {
        initial: { mode: "credential", target: missing.provider },
        onCredentialRef: (providerId, ref) => writeRecoveredCredentialRef({
          missing: { ...missing, provider: providerId }, ref, configPath, env: opts.env ?? process.env,
        }),
      }),
      notify: (message) => console.error(`aviso: ${redactSecrets(message)}`),
    });
    if (credential.kind === "declined" || credential.kind === "unresolved") {
      console.error(`erro: ${redactSecrets(credential.message)}`);
      return 1;
    }
    const createSession = (model?: string) => new AgentSession({
      configPath, cwd, env: opts.env ?? process.env,
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
      allowMissingConfig: opts.allowMissingConfig === true,
      approveSwap: approvals.approveSwap,
      onBudgetExceeded: approvals.onBudgetExceeded,
      approveTool: approvals.approveTool,
      trustAsk: async (dir) => trustChoice(await approvals.askText(trustPrompt(dir))),
      ...(opts.allowCritical === undefined ? {} : { allowCritical: opts.allowCritical }),
      ...(opts.allowSensitive === undefined ? {} : { allowSensitive: opts.allowSensitive }),
      ...(opts.artifactRoot === undefined ? {} : { artifactRoot: opts.artifactRoot }),
      ...(model === undefined ? {} : { model }),
    });
    // #557: o `!cmd` segue o aprovador e o modo corrente da sessão (/mode em runtime).
    let currentSession: ReturnType<typeof createSession> | undefined;
    // `--provider` explícito e `agent.model` declarado vencem o último modelo salvo (#497).
    const boot = await bootstrapTui({
      createSession: () => {
        currentSession = bootSession(createSession, cwd, {
          declaredModel: declaredModelFor(configPath, { env: opts.env }),
          ...(opts.provider === undefined ? {} : { provider: opts.provider }),
        });
        return currentSession;
      },
      setup: async () => {
        const configured = await setupProvider(manager, cwd, saveSecret, discardSecret);
        // #611: the wizard also owns the project layer after an in-TUI provider setup.
        if (configured) {
          await runSetup(configPath, { env: opts.env ?? process.env, allowMissing: opts.allowMissingConfig === true, acceptDefaults: true });
        }
        return configured;
      },
      createShell: () => createShellRunner({
        configPath, cwd, env: opts.env ?? process.env,
        allowMissingConfig: opts.allowMissingConfig === true,
        approveTool: approvals.approveTool,
        permissionMode: () => currentSession?.permissionMode(),
        ...(opts.allowCritical === undefined ? {} : { allowCritical: opts.allowCritical }),
        ...(opts.allowSensitive === undefined ? {} : { allowSensitive: opts.allowSensitive }),
      }),
      allowMissingConfig: opts.allowMissingConfig === true,
    });
    if (boot === undefined) {
      console.error(`erro: ${NO_PROVIDER_MESSAGE}`);
      return 1;
    }
    const { session, shell } = boot;
    for (const warning of session.warnings) console.error(`aviso: ${warning}`);
    let sessionApi: ReturnType<typeof openSessionApi>;
    let instance: ReturnType<typeof render> | undefined;
    const branch = gitBranch(cwd);
    try {
      sessionApi = openSessionApi(projectDataDir(cwd), { home: astroHomePath(opts.env ?? process.env) });
      instance = render(
        <TuiApp
          session={session}
          cwd={cwd}
          {...(branch === undefined ? {} : { branch })}
          {...(sessionApi === undefined ? {} : { sessionApi })}
          approvals={approvals}
          shell={shell}
          manager={manager}
          saveSecret={saveSecret}
          discardSecret={discardSecret}
          onExit={() => instance?.unmount()}
        />,
        TUI_RENDER_OPTIONS,
      );
      await instance.waitUntilExit();
      return 0;
    } finally {
      try {
        session.close();
      } catch {
        // turno abortado ainda em curso: o sinal já foi enviado
      }
      sessionApi?.close();
    }
  } catch (error) {
    console.error(`erro: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}
