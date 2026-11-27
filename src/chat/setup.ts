/** Setup wizard (#611): the first-run writer at the TUI terms gate, one config layer per run, never silent or TTY-less. */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { globalConfigPath } from "../astro-home";
import { loadConfigRaw } from "../core/config";
import { ProfileManager } from "../providers/profile-manager";
import { profileFromEnv, validateProjectLayer } from "../providers/profiles";
import { redactSecrets } from "../sanitize-external";
import { activeModelRefFromGlobal, createFileExclusive } from "./init";
import { runProviderWizard, type WizardIO } from "./provider-wizard";
import { nodeReplIO } from "./node-io";

/** One line printed on a machine without a terminal: nothing is asked or written. */
export const SETUP_UNATTENDED_NOTICE =
  "no interactive terminal: setup skipped, nothing written; defaults stay in memory (run `astro setup` in a terminal)";

export type SetupFlow = "skip" | "unattended" | "cancelled" | "full" | "short" | "project";

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  /** `--config` explicit: never create the layer implicitly. */
  allowMissing?: boolean;
  /** `astro setup --yes`: take the defaults without reading the terminal. */
  acceptDefaults?: boolean;
  /** Terminal channel; absent means no TTY: ask nothing, write nothing. */
  io?: WizardIO;
}

export interface SetupOutcome {
  flow: SetupFlow;
  globalCreated: boolean;
  projectCreated: boolean;
  preset?: "default" | "control";
  notice?: string;
}

function noWrites(flow: SetupFlow, extra: Partial<SetupOutcome> = {}): SetupOutcome {
  return { flow, globalCreated: false, projectCreated: false, ...extra };
}

/** Active model of the existing global layer; unreadable layer = `undefined`. */
function defaultModelRef(env: NodeJS.ProcessEnv): string | undefined {
  try { return activeModelRefFromGlobal(loadConfigRaw(globalConfigPath(env))); } catch { return undefined; }
}

/** Environment provider of the short flow; ambiguous or insecure env falls back to the full flow. */
function envSetupProfile(env: NodeJS.ProcessEnv) {
  try { return profileFromEnv(env); } catch { return undefined; }
}

/** Preset question (ADR-0033: `default` unless the user picks Control); `undefined` = cancelled. */
async function resolvePreset(io: WizardIO | undefined, acceptDefaults?: boolean): Promise<"default" | "control" | undefined> {
  if (acceptDefaults === true) return "default";
  if (io === undefined) return undefined;
  for (;;) {
    const answer = await io.read("profile [default/control] (default): ");
    if (answer === null) return undefined;
    const value = answer.trim().toLowerCase();
    if (value === "" || value === "default") return "default";
    if (value === "control") return "control";
    io.write('unknown profile: use "default" or "control"');
  }
}

/** Validates the project layer against the global one, then creates it (`wx`, never overwrites). */
function writeProjectLayer(configPath: string, layer: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean {
  validateProjectLayer(layer, env);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  return createFileExclusive(configPath, `${JSON.stringify(layer, null, 2)}\n`);
}

/** Global exists, project does not: preset + active global model; the global stays untouched. */
async function setupProjectLayer(configPath: string, env: NodeJS.ProcessEnv, opts: SetupOptions): Promise<SetupOutcome> {
  const model = defaultModelRef(env);
  // A global layer without providers (`{}`, the pre-#611 template) cannot back a project layer:
  // do not ask for a preset that cannot be written; the provider setup creates it later.
  if (model === undefined) {
    return noWrites("project", { notice: "global config has no provider yet; the project layer is created once one is set" });
  }
  const preset = await resolvePreset(opts.io, opts.acceptDefaults);
  if (preset === undefined) return noWrites("cancelled", { notice: "setup cancelled; nothing written" });
  return { flow: "project", globalCreated: false, preset, projectCreated: writeProjectLayer(configPath, { preset, agent: { model } }, env) };
}

/** No layer at all: reuses the linear provider wizard (`/provider add`), then writes the project layer. */
async function setupFull(configPath: string, env: NodeJS.ProcessEnv, opts: SetupOptions): Promise<SetupOutcome> {
  const preset = await resolvePreset(opts.io, opts.acceptDefaults);
  if (preset === undefined) return noWrites("cancelled", { notice: "setup cancelled; nothing written" });
  if (opts.io === undefined || opts.acceptDefaults === true) {
    return noWrites("full", { preset, notice: "no default provider available: run `astro setup` without --yes to choose one" });
  }
  const manager = new ProfileManager({ env });
  const saved = await runProviderWizard(opts.io, manager, {
    mode: "add",
    // Fail closed: a ref the environment does not provide would 401 on the first request.
    validate: (draft) => draft.credentialRef !== undefined && !manager.credentialPresent(draft.credentialRef)
      ? `${draft.credentialRef} is not set; export it or paste the key in the provider screen (vault)`
      : undefined,
  });
  if (saved === undefined) return noWrites("cancelled", { notice: "setup cancelled; nothing written" });
  const model = `${saved.id}/${saved.models[0]!.id}`;
  return { flow: "full", globalCreated: true, preset, projectCreated: writeProjectLayer(configPath, { preset, agent: { model } }, env) };
}

/** Environment provider: says which set it chose, offers to switch, writes nothing (no layer to own). */
async function setupFromEnvironment(configPath: string, env: NodeJS.ProcessEnv, opts: SetupOptions,
  profile: NonNullable<ReturnType<typeof envSetupProfile>>): Promise<SetupOutcome> {
  const source = `using ${profile.id} from $${profile.credentialRef ?? "env"}`;
  if (opts.acceptDefaults !== true && opts.io !== undefined) {
    const answer = await opts.io.read(`${source} — switch to the full setup? [y/N] `);
    if (answer === null) return noWrites("cancelled", { notice: "setup cancelled; nothing written" });
    if (/^(y|yes|s|sim)$/i.test(answer.trim())) return setupFull(configPath, env, opts);
  }
  // Nothing is persisted, so there is no preset to ask for: the profile choice would be lost.
  return {
    flow: "short", globalCreated: false, projectCreated: false,
    notice: `${source} (the environment owns it; nothing written — run \`astro setup\` to store a provider)`,
  };
}

/** Global present + project absent = project mini-setup that never writes the global layer; exists = skip. Without a terminal nothing is asked or written; no key enters a layer (I-03). */
export async function runSetup(configPath: string, opts: SetupOptions = {}): Promise<SetupOutcome> {
  const env = opts.env ?? process.env;
  if (opts.allowMissing !== true || env.ASTRO_NO_GLOBAL_CONFIG === "1" || existsSync(configPath)) {
    return noWrites("skip");
  }
  if (opts.io === undefined && opts.acceptDefaults !== true) {
    return noWrites("unattended", { preset: "default", notice: SETUP_UNATTENDED_NOTICE });
  }
  try {
    if (existsSync(globalConfigPath(env))) return await setupProjectLayer(configPath, env, opts);
    const envProfile = envSetupProfile(env);
    return envProfile === undefined
      ? await setupFull(configPath, env, opts)
      : await setupFromEnvironment(configPath, env, opts, envProfile);
  } catch (error) {
    return noWrites("cancelled", { notice: redactSecrets(error instanceof Error ? error.message : String(error)) });
  }
}

/** Terminal channel of the wizard; one readline and one close listener, closed before Ink mounts. */
export function ttySetupIO(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): { io: WizardIO; close: () => void } {
  const io = nodeReplIO(input, output);
  return { io, close: () => io.close() };
}
