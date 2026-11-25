/** Public entry points stay honest: the index covers docs/, README links resolve, templates and Dependabot carry the rules (#606). */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const root = join(import.meta.dir, "..");
const docs = join(root, "docs");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const posix = (path: string): string => relative(root, path).split(sep).join("/");

function markdown(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markdown(path, found);
    else if (entry.name.endsWith(".md")) found.push(posix(path));
  }
  return found;
}

const index = read("docs/INDEX.md");

describe("docs/INDEX.md", () => {
  test("lists every markdown file in docs/, directly or through its directory row", () => {
    const missing = markdown(docs)
      .filter((path) => path !== "docs/INDEX.md")
      .filter((path) => !index.includes(`\`${path}\``) && !index.includes(`\`${dirname(path).split(sep).join("/")}/\``));
    expect(missing).toEqual([]);
  });

  test("points at files that exist", () => {
    const entries = [...index.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1]!)
      .filter((path) => path.startsWith("docs/") || path === "AGENTS.md" || path === "README.md");
    expect(entries.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });
});

describe("README.md", () => {
  test("links the documentation map", () => {
    expect(read("README.md")).toContain("docs/INDEX.md");
  });

  test("has no dead relative link", () => {
    const targets = [...read("README.md").matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => decodeURIComponent(match[1]!.split("#")[0]!))
      .filter((target) => target !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(target));
    expect(targets.filter((target) => !existsSync(join(root, target)))).toEqual([]);
  });
});

describe(".github", () => {
  test("Dependabot covers bun and the workflows, never an empty ecosystem", () => {
    const config = read(".github/dependabot.yml");
    expect(config).not.toContain('package-ecosystem: ""');
    for (const ecosystem of ["bun", "github-actions"]) expect(config).toContain(`package-ecosystem: "${ecosystem}"`);
  });

  test("pull request template carries RED, double review and the size ceiling", () => {
    const template = read(".github/pull_request_template.md");
    for (const rule of ["Closes #", "RED", "Review: APPROVE", "400"]) expect(template).toContain(rule);
  });
});
