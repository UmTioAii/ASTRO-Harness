import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATH_HARD_BLOCKED,
  denyDisplayPath,
  pathCandidatesOf,
  resolveArtifactRoot,
  resolveAstroHome,
} from "../src/permissions";

describe("helpers do gate de hard-block (ADR-0027, #391 slice 1)", () => {
  test("PATH_HARD_BLOCKED é o reason code estável do deny", () => {
    expect(PATH_HARD_BLOCKED).toBe("path_hard_blocked");
  });

  test("pathCandidatesOf: input.path e tokens path-like de run_command", () => {
    expect(pathCandidatesOf({ name: "read_file", input: { path: ".env" } })).toEqual([".env"]);
    // content nunca é tratado como path
    expect(pathCandidatesOf({ name: "write_file", input: { path: "a.txt", content: ".env" } })).toEqual(["a.txt"]);
    expect(pathCandidatesOf({ name: "grep", input: { pattern: ".env", path: "src" } })).toEqual(["src"]);
    expect(pathCandidatesOf({ name: "grep", input: { pattern: "x" } })).toEqual([]);
    expect(pathCandidatesOf({ name: "run_command", input: { command: "cat .env && ls '~/.ssh' && echo token 2>&1" } }))
      .toEqual([".env", "~/.ssh"]);
    expect(pathCandidatesOf({ name: "run_command", input: { command: "echo oi" } })).toEqual([]);
    expect(pathCandidatesOf({ name: "run_command", input: {} })).toEqual([]);
    expect(pathCandidatesOf({ name: "read_file", input: "só texto" })).toEqual([]);
    expect(pathCandidatesOf({ name: "read_file", input: { path: 42 } })).toEqual([]);
  });

  test("denyDisplayPath: relativo no cwd, <fora do cwd> fora, ~ expandido", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-hb-disp-"));
    expect(denyDisplayPath(cwd, ".env")).toBe(".env");
    expect(denyDisplayPath(cwd, join("sub", ".env"))).toBe(join("sub", ".env"));
    expect(denyDisplayPath(cwd, "sub/../.env")).toBe(".env");
    expect(denyDisplayPath(cwd, "../fora.txt")).toBe("<fora do cwd>");
    expect(denyDisplayPath(cwd, join(cwd, "..", "outside.txt"))).toBe("<fora do cwd>");
    expect(denyDisplayPath(cwd, "~/.ssh/id_rsa")).toBe("<fora do cwd>");
    expect(denyDisplayPath(cwd, "~outro-usuario/x")).toBe("<fora do cwd>");
  });

  test("resolveAstroHome/resolveArtifactRoot: env ou defaults", () => {
    expect(resolveAstroHome({})).toBe(join(homedir(), ".astro"));
    expect(resolveAstroHome({ ASTRO_HOME: "   " })).toBe(join(homedir(), ".astro"));
    expect(resolveAstroHome({ ASTRO_HOME: "/tmp/custom-astro-home" })).toBe("/tmp/custom-astro-home");
    expect(resolveArtifactRoot({})).toBeNull();
    expect(resolveArtifactRoot({ ASTRO_ARTIFACT_ROOT: "  " })).toBeNull();
    expect(resolveArtifactRoot({ ASTRO_ARTIFACT_ROOT: "/tmp/arts" })).toBe("/tmp/arts");
  });
});
