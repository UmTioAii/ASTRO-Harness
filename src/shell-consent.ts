/**
 * Shell-risk consent (#599): the shell runs on the user's machine with the user's
 * authority, so the risk is acknowledged once, next to the terms, and stored in
 * `$ASTRO_HOME/state.json` with version and date. No network, no credential.
 */
import { createInterface } from "node:readline";
import { statePath } from "./astro-home";
import { loadHomeState, saveHomeState, type ConsentRecord } from "./home-state";

/** Bump this when the text changes: the next interactive boot asks again. */
export const SHELL_CONSENT_VERSION = "1";

/** Shown once, at the same gate as the terms. */
export const SHELL_CONSENT_LINES: readonly string[] = [
  "The shell runs on your machine with your authority, outside a container.",
  "A model-requested command needs your approval unless a shell rule allows it.",
  "The allowlist, the scanner and the hard-blocks are guardrails, not a guarantee.",
];

/** One line for a declined consent: the app keeps running, the shell stays off. */
export const SHELL_CONSENT_DECLINED_NOTICE =
  "shell-risk consent declined: the shell stays off for this session — accept it at the next interactive start";

/** Prompt of the gate: the whole text and the contract of Enter. */
export function shellConsentPrompt(previous?: ConsentRecord): string {
  const header = previous === undefined
    ? `shell risk consent (version ${SHELL_CONSENT_VERSION}):`
    : `shell risk consent (version ${previous.version} → ${SHELL_CONSENT_VERSION}):`;
  return [
    header,
    ...SHELL_CONSENT_LINES.map((line, index) => `  ${index + 1}. ${line}`),
    "",
    `Enter accepts and records version ${SHELL_CONSENT_VERSION}; any other answer declines: `,
  ].join("\n");
}

/** Only the empty line (Enter) accepts; space, another answer and EOF (`null`) decline. */
export function shellConsentChoice(answer: string | null | undefined): boolean {
  return answer === "";
}

/** Record or `undefined` when never accepted. An invalid state is an error. */
export function loadShellConsent(path: string = statePath()): ConsentRecord | undefined {
  return loadHomeState(path).shell;
}

/** Writes the record preserving terms, trust and migrations. */
export function saveShellConsent(record: ConsentRecord, path: string = statePath()): void {
  const state = loadHomeState(path);
  saveHomeState({ ...state, shell: { version: record.version, acceptedAt: record.acceptedAt } }, path);
}

/** `/terms` status; an unreadable state warns with the path only and never throws (I-03). */
export function shellConsentReport(path: string = statePath()): string {
  let status: string;
  try {
    const record = loadShellConsent(path);
    status = record === undefined
      ? "shell risk consent: not accepted — the next interactive start asks for Enter"
      : record.version === SHELL_CONSENT_VERSION
        ? `shell risk consent: accepted on ${record.acceptedAt} (version ${record.version})`
        : `shell risk consent: accepted on ${record.acceptedAt} for version ${record.version}; ` +
          `version ${SHELL_CONSENT_VERSION} is not accepted — the next interactive start asks again`;
  } catch {
    status = `shell risk consent: unreadable state at ${path} — fix the file or delete the "shell" field`;
  }
  return [`Shell risk consent (version ${SHELL_CONSENT_VERSION})`, "", ...SHELL_CONSENT_LINES, "", status].join("\n");
}

/** Interactive channel: `true` writes the record, `false` declines. */
export type ShellConsentAsk = (previous: ConsentRecord | undefined) => boolean | Promise<boolean>;

export type ShellConsentDecision =
  /** Current version already accepted: no prompt. */
  | { kind: "current"; record: ConsentRecord }
  /** Accepted now and written. */
  | { kind: "accepted"; record: ConsentRecord }
  /** Declined: nothing was written, the shell stays off for the session. */
  | { kind: "declined" }
  /** No interactive channel: continue without prompting or writing. */
  | { kind: "unattended" };

export interface EnsureShellConsentOptions {
  /** `state.json` path (tests); default `statePath()`. */
  path?: string;
  /** Absent = no interactive channel (eval/CI, stdin in a pipe). */
  ask?: ShellConsentAsk;
  /** Test clock; default `new Date()`. */
  now?: () => Date;
}

/**
 * Consent gate: current version → `current`; missing or stale → ask once; no
 * channel → `unattended`, writing nothing. A decline never writes, so the next
 * interactive start asks again.
 */
export async function ensureShellConsent(opts: EnsureShellConsentOptions = {}): Promise<ShellConsentDecision> {
  const path = opts.path ?? statePath();
  const current = loadShellConsent(path);
  if (current?.version === SHELL_CONSENT_VERSION) return { kind: "current", record: current };
  if (opts.ask === undefined) return { kind: "unattended" };
  if (!(await opts.ask(current))) return { kind: "declined" };
  const record: ConsentRecord = {
    version: SHELL_CONSENT_VERSION,
    acceptedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  saveShellConsent(record, path);
  return { kind: "accepted", record };
}

/** TTY channel; without an interactive terminal returns `undefined` (never asks). */
export function ttyShellConsentAsk(): ShellConsentAsk | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined;
  return async (previous) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      // EOF (Ctrl-D) declines, like any answer other than Enter.
      const answer = await new Promise<string | null>((resolve) => {
        rl.once("close", () => resolve(null));
        rl.question(shellConsentPrompt(previous), resolve);
      });
      return shellConsentChoice(answer);
    } finally {
      rl.close();
    }
  };
}
