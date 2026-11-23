/**
 * Persists an `always` shell approval as a prefix rule in `shell.approvals`
 * (#599), never next to `shell.rules`, so it cannot outrank a configured
 * `deny`; only the derived prefix is written, never the command. Failure
 * leaves the file untouched. The JSON is read/written directly to keep the
 * config → run-command → approvals import graph acyclic.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../sanitize-external";
import type { ShellRule } from "./shell-policy";

/** Cap of saved approvals; above it `always` degrades to the single call. */
export const MAX_SHELL_APPROVALS = 100;
const MAX_PATTERN_CHARS = 200;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function persistShellApproval(configPath: string, pattern: string): boolean {
  // A pattern carrying a redaction marker came from a secret: never persist it.
  if (pattern.trim() === "" || pattern.length > MAX_PATTERN_CHARS || redactSecrets(pattern) !== pattern) return false;
  if (!existsSync(configPath)) return false;
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isObject(raw)) return false;
    const shell = isObject(raw.shell) ? raw.shell : {};
    const approvals = Array.isArray(shell.approvals) ? shell.approvals.filter(isObject) as unknown as ShellRule[] : [];
    if (approvals.some((rule) => rule.match === pattern && rule.effect === "allow")) return true;
    if (approvals.length >= MAX_SHELL_APPROVALS) return false;
    const next = { ...raw, shell: { ...shell, approvals: [...approvals, { match: pattern, effect: "allow" }] } };
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, configPath);
    } catch {
      try { unlinkSync(temporary); } catch { /* best-effort */ }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
