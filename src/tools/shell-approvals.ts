/**
 * Persists an `always` shell approval as a prefix rule in `shell.approvals`
 * (#599), never next to `shell.rules`, so it cannot outrank a configured
 * `deny`; only the derived prefix is written, never the command. Failure
 * leaves the file untouched and carries a stable reason. The JSON is read and
 * written directly to keep the config → run-command → approvals graph acyclic.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../sanitize-external";
import type { ShellRule } from "./shell-policy";
import type { ApprovalSave } from "./types";

/** Cap of saved approvals; above it `always` degrades to the single call. */
export const MAX_SHELL_APPROVALS = 100;
const MAX_PATTERN_CHARS = 200;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A pattern must be exactly `<literal prefix> *`; a prefix wildcard is refused. */
function safePrefix(pattern: string): string | undefined {
  if (!pattern.endsWith(" *")) return undefined;
  const prefix = pattern.slice(0, -2).trim();
  return prefix === "" || prefix.includes("*") ? undefined : prefix;
}

export function persistShellApproval(configPath: string, pattern: string): ApprovalSave {
  // A pattern carrying a wildcard in the prefix or a redaction marker came from
  // a secret: never persist it.
  if (safePrefix(pattern) === undefined) {
    return {
      ok: false,
      reason: "unsafe_pattern (the command starts with a wildcard, so it cannot be saved as a prefix)",
    };
  }
  if (pattern.length > MAX_PATTERN_CHARS || redactSecrets(pattern) !== pattern) {
    return { ok: false, reason: "unsafe_pattern (the prefix contains a secret)" };
  }
  if (!existsSync(configPath)) return { ok: false, reason: "no_config (no project config file to write)" };
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isObject(raw)) return { ok: false, reason: "write_failed (the config is not an object)" };
    const shell = isObject(raw.shell) ? raw.shell : {};
    const approvals = Array.isArray(shell.approvals) ? shell.approvals.filter(isObject) as unknown as ShellRule[] : [];
    if (approvals.some((rule) => rule.match === pattern && rule.effect === "allow")) return { ok: true, pattern };
    if (approvals.length >= MAX_SHELL_APPROVALS) return { ok: false, reason: "limit_reached (too many saved approvals)" };
    const next = { ...raw, shell: { ...shell, approvals: [...approvals, { match: pattern, effect: "allow" }] } };
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, configPath);
    } catch {
      try { unlinkSync(temporary); } catch { /* best-effort */ }
      return { ok: false, reason: "write_failed (the project config could not be written)" };
    }
    return { ok: true, pattern };
  } catch {
    return { ok: false, reason: "write_failed (the project config could not be read)" };
  }
}
