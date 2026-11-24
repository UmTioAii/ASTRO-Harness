import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// Ordered prefix rules, the in-house compound scanner and external_directory (#599).
export const SHELL_UNPARSABLE = "shell_unparsable";
export const SHELL_RULE_DENIED = "shell_rule_denied";
export const EXTERNAL_DIRECTORY = "external_directory";
export type ShellRuleEffect = "allow" | "ask" | "deny";
export type ShellExternalDirectory = ShellRuleEffect;
/** `match` is a prefix pattern; `*` matches the rest of the subcommand. */
export interface ShellRule { match: string; effect: ShellRuleEffect }
export type ShellPolicyConfig = {
  rules?: readonly ShellRule[];
  /** Saved `always` approvals (#599); never override a rule `deny`. */
  approvals?: readonly ShellRule[];
  externalDirectory?: ShellExternalDirectory;
};
export type ShellPolicyResult = {
  decision: ShellRuleEffect;
  origin: "rule" | "external_directory" | "unparsable" | "approval" | "default";
  trigger?: string;
  /** Subcommands that still need a decision (no allow rule, no saved approval). */
  uncovered?: readonly string[];
  code?: string;
  message?: string;
};
export type ShellScan =
  | { ok: true; parts: readonly string[]; words: readonly (readonly string[])[] }
  | { ok: false; code: typeof SHELL_UNPARSABLE; message: string };

const UNPARSABLE =
  "shell_unparsable: the command cannot be analyzed before execution (dynamic expansion " +
  "such as $, backticks or %VAR%, a trailing operator, or unbalanced quotes); rewrite it " +
  "as literal subcommands without $, ` or % and retry";
const refuse = (): ShellScan => ({ ok: false, code: SHELL_UNPARSABLE, message: UNPARSABLE });
const WIN = process.platform === "win32";

/** On Windows a backslash is a path separator, not an escape for letters/dots. */
const escapes = (next: string | undefined): boolean =>
  next !== undefined && (!WIN || next === '"' || next === "'" || next === " " || next === "\t");

/** Split a command line into subcommands; quoted operators stay literal. */
export function scanShellCommand(command: string): ShellScan {
  const parts: string[][] = [];
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | null = null;
  let expectCommand = true; // makes `ls &&`, `; ls`, `a || | b` and `ls;` unparsable
  const flushWord = (): void => {
    if (wordStarted || word.length > 0) words.push(word);
    word = "";
    wordStarted = false;
  };
  const flushPart = (): void => {
    flushWord();
    if (words.length > 0) parts.push(words.splice(0, words.length));
  };
  const separator = (): boolean => {
    if (expectCommand) return false;
    flushPart();
    expectCommand = true;
    return true;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === "$" || ch === "`" || ch === "%") return refuse();
      if (ch === "\\") {
        const next = command[i + 1];
        if (next === undefined && !WIN) return refuse();
        if (escapes(next)) { word += next as string; i += 1; } else word += "\\";
        continue;
      }
      word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; wordStarted = true; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { flushWord(); continue; }
    if (ch === "\n" || ch === ";") { if (!separator()) return refuse(); continue; }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined && !WIN) return refuse();
      if (escapes(next)) { word += next as string; i += 1; } else word += "\\";
      wordStarted = true;
      continue;
    }
    if (ch === "$" || ch === "`" || ch === "%") return refuse();
    if (ch === "&") {
      if (word.endsWith(">") || word.endsWith("<")) { word += ch; continue; } // 2>&1
      if (command[i + 1] === "&") i += 1;
      if (!separator()) return refuse();
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") i += 1;
      if (!separator()) return refuse();
      continue;
    }
    if (ch === "(") { flushPart(); expectCommand = true; continue; }
    if (ch === ")") { flushPart(); expectCommand = false; continue; }
    word += ch;
    wordStarted = true;
    expectCommand = false;
  }
  if (quote !== null || expectCommand) return refuse();
  flushPart();
  if (parts.length === 0) return refuse();
  return { ok: true, parts: parts.map((part) => part.join(" ").trim()), words: parts };
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Correlation digest of a shell decision (D-11): 16 hex chars of SHA-256, never
 * the command. Short on purpose: audit keeps it readable, and a 64-hex value
 * would be treated as a secret by the redactor.
 */
export function shellCommandHash(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

/** Prefix of a saved `always` approval: first subcommand, plus the git subcommand (#599). */
export function approvalPattern(command: string): string | undefined {
  const scan = scanShellCommand(command);
  if (!scan.ok) return undefined;
  const words = scan.words[0];
  if (words === undefined || words.length === 0) return undefined;
  const head = words[0] === "git" && words[1] !== undefined ? `${words[0]} ${words[1]}` : words[0];
  // A literal `*` in the command would become wildcard syntax in the saved
  // rule (`* --version` → `* *` allows everything). Refuse it: the approval
  // then covers this call only.
  if (head.includes("*")) return undefined;
  return `${head} *`;
}

/** Prefix pattern, anchored; a trailing ` *` also matches the bare prefix. */
function matches(pattern: string, part: string): boolean {
  const normalized = pattern.trim().replace(/\s+/g, " ");
  if (normalized === "*") return true;
  const optional = normalized.endsWith(" *");
  const body = optional ? normalized.slice(0, -2) : normalized;
  const expression = body.split("*").map(escapeRegex).join(".*") + (optional ? "( .*)?" : "");
  return new RegExp(`^${expression}$`).test(part);
}

/** The value a path-like decision must classify: redirect or `--flag=` unwrapped. */
function tokenValue(token: string): string | undefined {
  const bare = token.replace(/^[<>]+/, "");
  if (bare.length === 0) return undefined;
  if (!bare.startsWith("-")) return bare;
  if (bare.includes("=")) return bare.slice(bare.indexOf("=") + 1) || undefined;
  const attached = bare.search(/[./\\]/);
  return attached === -1 ? bare : bare.slice(attached);
}

function isPathLike(token: string): boolean {
  const value = tokenValue(token);
  if (value === undefined || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false; // URL
  if (value === "." || value === "..") return true;
  if (value.includes("/") || value.includes("\\") || value.startsWith("~")) return true;
  return /^[a-zA-Z]:/.test(value) || /\.[A-Za-z0-9]+$/.test(value);
}

/** Physical root, so a symlinked/junction project does not make itself external. */
function physical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function outsideProject(token: string, base: string): boolean {
  const value = tokenValue(token);
  if (value === undefined) return false;
  if (value.startsWith("~")) return true; // another home is never the project
  const root = physical(base);
  let real = resolve(root, value);
  try { real = realpathSync(real); } catch { /* missing paths stay lexical */ }
  const rel = relative(root, real);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** First subcommand outside the project; `cd <path>` moves the base for the rest. */
function externalPart(parts: readonly (readonly string[])[], cwd: string): string | undefined {
  let base = physical(cwd);
  for (const words of parts) {
    const first = words[0];
    if (first === "cd" || first === "pushd") {
      const target = words.slice(1).find((word) => !word.startsWith("-"));
      if (target === undefined || outsideProject(target, base)) return words.join(" ");
      base = physical(resolve(base, tokenValue(target) ?? target));
      continue;
    }
    if (words.some((word) => isPathLike(word) && outsideProject(word, base))) return words.join(" ");
  }
  return undefined;
}

/**
 * Evaluate rules and external_directory before the permission matrix. Every
 * subcommand is evaluated; the last matching rule wins. A `deny` is returned as
 * such, so no mode or saved approval can lift it. A saved approval only covers a
 * subcommand whose rule decision is not `allow` (or every subcommand when no
 * rules are configured), and never a `deny`.
 */
export function evaluateShellPolicy(
  command: string,
  cwd: string,
  policy: ShellPolicyConfig = {},
): ShellPolicyResult {
  const scan = scanShellCommand(command);
  if (!scan.ok) return { decision: "deny", origin: "unparsable", code: scan.code, message: scan.message };
  const rules = policy.rules ?? [];
  const approvals = policy.approvals ?? [];
  const perPart = scan.parts.map((part) => {
    let effect: ShellRuleEffect | undefined;
    for (const rule of rules) if (matches(rule.match, part)) effect = rule.effect;
    return { part, effect };
  });
  for (const { part, effect } of perPart) {
    if (effect === "deny") {
      return {
        decision: "deny", origin: "rule", trigger: part, code: SHELL_RULE_DENIED,
        message: "shell_rule_denied: the command matches an explicit deny rule in shell.rules; " +
          "remove or reorder the rule to allow it",
      };
    }
  }
  const saved = (part: string): boolean =>
    approvals.some((rule) => rule.effect === "allow" && matches(rule.match, part));
  // Parts without an explicit allow; with no rules, every part needs a saved approval.
  const gated = perPart.filter(({ effect }) => rules.length > 0 ? effect !== "allow" : true);
  const uncovered = gated.filter(({ part }) => !saved(part));
  let decision: ShellRuleEffect = "allow";
  let trigger: string | undefined;
  let origin: ShellPolicyResult["origin"] = "default";
  if (gated.length > 0 && uncovered.length === 0) {
    origin = "approval";
  } else if (rules.length > 0) {
    origin = "rule";
    if (uncovered.length > 0) {
      decision = "ask";
      trigger = uncovered[0]?.part;
    }
  }
  const external = externalPart(scan.words, cwd);
  if (external !== undefined) {
    const mode = policy.externalDirectory ?? "ask";
    if (mode === "deny") {
      return {
        decision: "deny", origin: "external_directory", trigger: external, code: EXTERNAL_DIRECTORY,
        message: "external_directory: the command targets a path outside the project; " +
          'set shell.externalDirectory to "ask" or "allow" to permit it',
      };
    }
    if (mode === "ask") {
      return {
        decision: "ask", origin: "external_directory", trigger: external,
        uncovered: uncovered.map(({ part }) => part),
      };
    }
  }
  return {
    decision, origin,
    ...(trigger === undefined ? {} : { trigger }),
    uncovered: uncovered.map(({ part }) => part),
  };
}
