import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { Auditor } from "../src/audit";
import { bootChat } from "../src/chat/boot";
import { nodeReplIO } from "../src/chat/node-io";
import { loadHomeState, saveHomeState } from "../src/home-state";
import {
  SHELL_CONSENT_LINES,
  SHELL_CONSENT_VERSION,
  ensureShellConsent,
  loadShellConsent,
  saveShellConsent,
  shellConsentChoice,
  shellConsentPrompt,
  shellConsentReport,
} from "../src/shell-consent";
import { saveTermsAcceptance } from "../src/terms";
import { ToolExecutor } from "../src/tools/executor";
import { installNoDockerSpawnMock, isolatedRunCommand, type DockerMock, type RunCommandModule } from "./helpers/docker-mock";

const ISO = "2026-11-20T12:00:00.000Z";
const stateFile = (): string => join(mkdtempSync(join(tmpdir(), "astro-shell-consent-")), "home", "state.json");

let mock: DockerMock | undefined;
afterEach(() => { mock?.restore(); mock = undefined; });

/** Runs one command through the real gate; returns the result and the prompts it saw. */
async function gatedRun(mod: RunCommandModule, command: string) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-shell-consent-"));
  const requests: unknown[] = [];
  const executor = new ToolExecutor({
    tools: [mod.runCommandTool], allow: ["run_command"], audit: new Auditor(join(cwd, ".astro", "audit.jsonl")),
    permissionMode: "ask", approveTool: (request) => { requests.push(request); return true; },
  });
  const result = await executor.run({ cwd, run: "r1", agent: "coder", env: { ...process.env } },
    { id: "c1", name: "run_command", arguments: JSON.stringify({ command }) });
  return { result, requests };
}

describe("shell-risk consent (#599)", () => {
  test("the text is versioned and names authority, approval and the allowlist limit", () => {
    expect(SHELL_CONSENT_VERSION).toMatch(/^\d+$/);
    expect(SHELL_CONSENT_LINES.length).toBeGreaterThanOrEqual(3);
    for (const line of SHELL_CONSENT_LINES) expect(line.trim()).not.toBe("");
    const text = SHELL_CONSENT_LINES.join(" ");
    expect(text).toMatch(/machine/i);
    expect(text).toMatch(/approval/i);
    expect(text).toMatch(/guarantee/i);
    const prompt = shellConsentPrompt();
    for (const line of SHELL_CONSENT_LINES) expect(prompt).toContain(line);
    expect(shellConsentPrompt({ version: "0", acceptedAt: ISO })).toContain("version 0");
    // Only the empty line accepts; anything else, including EOF, declines.
    expect(shellConsentChoice("")).toBe(true);
    for (const answer of [" ", "y", "s", null, undefined]) expect(shellConsentChoice(answer)).toBe(false);
  });

  test("the first run asks once and records version + date next to the terms", async () => {
    const path = stateFile();
    saveTermsAcceptance({ version: "1", acceptedAt: ISO }, path);
    const asked: unknown[] = [];
    const decision = await ensureShellConsent({
      path, ask: (previous) => { asked.push(previous); return shellConsentChoice(""); }, now: () => new Date(ISO),
    });
    expect(asked).toEqual([undefined]);
    expect(decision).toEqual({ kind: "accepted", record: { version: SHELL_CONSENT_VERSION, acceptedAt: ISO } });
    expect(loadShellConsent(path)).toEqual({ version: SHELL_CONSENT_VERSION, acceptedAt: ISO });
    // The record is only version + date, and it does not disturb the terms acceptance.
    expect(loadHomeState(path).terms).toEqual({ version: "1", acceptedAt: ISO });
    const raw = JSON.parse(readFileSync(path, "utf8")) as { shell: Record<string, unknown> };
    expect(Object.keys(raw.shell).sort()).toEqual(["acceptedAt", "version"]);
  });

  test("the current version never asks again; a stale one re-prompts once and replaces the record", async () => {
    const path = stateFile();
    saveShellConsent({ version: SHELL_CONSENT_VERSION, acceptedAt: ISO }, path);
    expect(await ensureShellConsent({ path, ask: () => { throw new Error("must not ask"); } }))
      .toEqual({ kind: "current", record: { version: SHELL_CONSENT_VERSION, acceptedAt: ISO } });
    saveShellConsent({ version: "0", acceptedAt: "2020-01-01T00:00:00.000Z" }, path);
    let previous: unknown;
    let prompts = 0;
    const stale = await ensureShellConsent({
      path, now: () => new Date("2026-11-21T00:00:00.000Z"),
      ask: (record) => { prompts++; previous = record; return true; },
    });
    expect(prompts).toBe(1);
    expect(previous).toEqual({ version: "0", acceptedAt: "2020-01-01T00:00:00.000Z" });
    expect(stale).toEqual({
      kind: "accepted", record: { version: SHELL_CONSENT_VERSION, acceptedAt: "2026-11-21T00:00:00.000Z" },
    });
  });

  test("declining writes nothing, leaves the state byte-identical, and no channel writes nothing", async () => {
    const path = stateFile();
    expect(await ensureShellConsent({ path, ask: () => false })).toEqual({ kind: "declined" });
    expect(existsSync(path)).toBe(false);
    saveHomeState({ version: 1, trust: { folders: ["/project"] }, migrations: { providers: true, trust: true } }, path);
    const before = readFileSync(path, "utf8");
    expect(await ensureShellConsent({ path, ask: (previous) => shellConsentChoice("no") && previous !== null }))
      .toEqual({ kind: "declined" });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(loadHomeState(path).shell).toBeUndefined();
    const other = stateFile();
    expect(await ensureShellConsent({ path: other })).toEqual({ kind: "unattended" });
    expect(existsSync(other)).toBe(false);
  });

  test("an invalid record is an error citing the path, never the content", () => {
    const path = stateFile();
    mkdirSync(dirname(path), { recursive: true });
    const base = {
      version: 1, trust: { folders: [] }, migrations: { providers: false, trust: false },
      terms: { version: "1", acceptedAt: ISO },
    };
    for (const shell of [
      { version: "1" },
      { version: "1", acceptedAt: "yesterday" },
      { version: "", acceptedAt: ISO },
      { version: "1", acceptedAt: ISO, command: "rm -rf /" },
    ]) {
      writeFileSync(path, JSON.stringify({ ...base, shell }));
      expect(() => loadShellConsent(path)).toThrow(path);
    }
  });

  test("the /terms report shows the shell consent status", () => {
    const path = stateFile();
    expect(shellConsentReport(path)).toContain("not accepted");
    saveShellConsent({ version: SHELL_CONSENT_VERSION, acceptedAt: ISO }, path);
    expect(shellConsentReport(path)).toContain(ISO);
  });

  test("the chat gate asks the shell consent right after the terms and records both", async () => {
    const path = stateFile();
    const asked: string[] = [];
    const boot = await bootChat({
      path,
      ask: () => { asked.push("terms"); return true; },
      shellAsk: () => { asked.push("shell"); return true; },
      now: () => new Date(ISO),
      createIO: () => nodeReplIO(new PassThrough(), new PassThrough()),
    });
    if (boot.kind !== "ready") throw new Error(`expected ready, got ${boot.kind}`);
    boot.io.close();
    expect(asked).toEqual(["terms", "shell"]);
    const saved = loadHomeState(path);
    expect(saved.terms).toEqual({ version: "1", acceptedAt: ISO });
    expect(saved.shell).toEqual({ version: SHELL_CONSENT_VERSION, acceptedAt: ISO });
  });
});

describe("declined shell consent disables the shell (#599)", () => {
  test("run_command is refused without a prompt and never spawns", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("consent-declined");
    mod.configureRunCommand({ mode: "host", rules: [{ match: "*", effect: "allow" }] });
    mod.setShellConsent("declined");
    const denied = await gatedRun(mod, "echo consent");
    expect(denied.result.code).toBe("shell_consent_declined");
    expect(denied.requests).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
    // A record (or no record) keeps the shell on: only an explicit decline disables it.
    mod.setShellConsent("unrecorded");
    expect((await gatedRun(mod, "echo consent")).result.isError).toBeFalsy();
  });
});
