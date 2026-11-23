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
  externalDirectory?: ShellExternalDirectory;
};
export type ShellPolicyResult = {
  decision: ShellRuleEffect;
  origin: "rule" | "external_directory" | "unparsable" | "default";
  trigger?: string;
  code?: string;
  message?: string;
};
export type ShellScan =
  | { ok: true; parts: readonly string[]; words: readonly (readonly string[])[] }
  | { ok: false; code: typeof SHELL_UNPARSABLE; message: string };

const UNPARSABLE =
  "shell_unparsable: the command cannot be analyzed before execution (dynamic expansion, " +
  "backticks or unbalanced syntax); rewrite it as literal subcommands without $ or ` " +
  "(and without unmatched quotes) and retry";
const refuse = (): ShellScan => ({ ok: false, code: SHELL_UNPARSABLE, message: UNPARSABLE });

/** Split a command line into subcommands; quoted operators stay literal. */
export function scanShellCommand(command: string): ShellScan {
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(command)) return refuse(); // cmd.exe expansion
  const parts: string[][] = [];
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | null = null;
  let expectCommand = true; // makes `ls &&`, `; ls` and `a || | b` unparsable
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
      if (ch === "$" || ch === "`") return refuse();
      if (ch === "\\") {
        const next = command[i + 1];
        if (next === undefined) return refuse();
        word += next;
        i += 1;
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
      if (next === undefined) return refuse();
      word += next;
      wordStarted = true;
      i += 1;
      continue;
    }
    if (ch === "$" || ch === "`") return refuse();
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

/** Prefix pattern, anchored: `git status *` covers `git status -s`, `git *` too. */
function matches(pattern: string, part: string): boolean {
  const normalized = pattern.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return false;
  return new RegExp(`^${normalized.split("*").map(escapeRegex).join(".*")}$`).test(part);
}

function isPathLike(token: string): boolean {
  const bare = token.replace(/^[<>]+/, "");
  const value = bare.startsWith("-") && bare.includes("=") ? bare.slice(bare.indexOf("=") + 1) : bare;
  if (value.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false; // URL
  if (value.includes("/") || value.includes("\\") || value.startsWith("~")) return true;
  return /^[a-zA-Z]:/.test(value) || /\.[A-Za-z0-9]+$/.test(value);
}

/** Resolve existing paths so a symlink or `..` cannot hide the escape. */
function outsideProject(token: string, cwd: string): boolean {
  const bare = token.replace(/^[<>]+/, "");
  if (bare.startsWith("~")) return true;
  let real = resolve(cwd, bare);
  try { real = realpathSync(real); } catch { /* missing paths stay lexical */ }
  const rel = relative(resolve(cwd), real);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function externalPart(parts: readonly (readonly string[])[], cwd: string): string | undefined {
  for (const words of parts) {
    if (words.some((word) => isPathLike(word) && outsideProject(word, cwd))) return words.join(" ");
  }
  return undefined;
}

/**
 * Evaluate rules and external_directory before the permission matrix. Every
 * subcommand is evaluated; the last matching rule wins. A `deny` is returned as
 * such, so no mode or saved approval can lift it.
 */
export function evaluateShellPolicy(
  command: string,
  cwd: string,
  policy: ShellPolicyConfig = {},
): ShellPolicyResult {
  const scan = scanShellCommand(command);
  if (!scan.ok) return { decision: "deny", origin: "unparsable", code: scan.code, message: scan.message };
  const rules = policy.rules ?? [];
  let decision: ShellRuleEffect = "allow";
  let trigger: string | undefined;
  let origin: ShellPolicyResult["origin"] = "default";
  if (rules.length > 0) {
    origin = "rule";
    for (const part of scan.parts) {
      let partDecision: ShellRuleEffect | undefined;
      for (const rule of rules) if (matches(rule.match, part)) partDecision = rule.effect;
      if (partDecision === "deny") {
        return {
          decision: "deny", origin: "rule", trigger: part, code: SHELL_RULE_DENIED,
          message: "shell_rule_denied: the command matches an explicit deny rule in shell.rules; " +
            "remove or reorder the rule to allow it",
        };
      }
      if (partDecision !== "allow" && decision === "allow") {
        decision = "ask";
        trigger = part;
      }
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
    if (mode === "ask") return { decision: "ask", origin: "external_directory", trigger: external };
  }
  return { decision, origin, ...(trigger === undefined ? {} : { trigger }) };
}
