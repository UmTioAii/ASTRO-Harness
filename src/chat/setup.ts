/** Setup wizard (#611): the first-run writer at the TUI terms gate, one config layer per run, never silent or TTY-less. */
import { existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { globalConfigPath } from "../astro-home";
import { loadConfigRaw } from "../core/config";
import { ProfileManager } from "../providers/profile-manager";
import { profileFromEnv, validateProjectLayer } from "../providers/profiles";
import { redactSecrets } from "../sanitize-external";
import { activeModelRefFromGlobal, createFileExclusive } from "./init";
import { runProviderWizard, type WizardIO } from "./provider-wizard";

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
  const preset = await resolvePreset(opts.io, opts.acceptDefaults);
  if (preset === undefined) return noWrites("cancelled", { notice: "setup cancelled; nothing written" });
  const model = defaultModelRef(env);
  const layer = { preset, ...(model === undefined ? {} : { agent: { model } }) };
  return { flow: "project", globalCreated: false, projectCreated: writeProjectLayer(configPath, layer, env), preset };
}

/** No layer at all: reuses the linear provider wizard (`/provider add`), then writes the project layer. */
async function setupFull(configPath: string, env: NodeJS.ProcessEnv, opts: SetupOptions): Promise<SetupOutcome> {
  const preset = await resolvePreset(opts.io, opts.acceptDefaults);
  if (preset === undefined) return noWrites("cancelled", { notice: "setup cancelled; nothing written" });
  if (opts.io === undefined || opts.acceptDefaults === true) {
    return noWrites("full", { preset, notice: "no default provider available: run `astro setup` without --yes to choose one" });
  }
  const saved = await runProviderWizard(opts.io, new ProfileManager({ env }), { mode: "add" });
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
  const preset = await resolvePreset(opts.io, opts.acceptDefaults);
  if (preset === undefined) return noWrites("cancelled", { notice: "setup cancelled; nothing written" });
  return {
    flow: "short", globalCreated: false, projectCreated: false, preset,
    notice: `${source} (nothing written; set ASTRO_PROVIDER or run the full setup to persist a provider)`,
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

/** Terminal channel of the wizard; one readline, closed before the TUI mounts Ink. */
export function ttySetupIO(): { io: WizardIO; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: WizardIO = {
    read: (prompt) => new Promise<string | null>((resolve) => {
      rl.once("close", () => resolve(null)); // EOF (Ctrl-D) cancels
      rl.question(prompt, resolve);
    }),
    write: (text) => { process.stdout.write(`${text}\n`); },
  };
  return { io, close: () => rl.close() };
}
