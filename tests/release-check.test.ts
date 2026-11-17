import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  buildSummary,
  createPlan,
  executePlan,
  parseArgs,
  tarballFileName,
  tempDirPrefix,
  type StepResult,
} from "../scripts/release-check";

const root = resolve(import.meta.dir, "..");
const tempRoot = join(root, ".tmp-release-check");
const tempDir = join(tempRoot, `${tempDirPrefix("@umtioaii/astro-harness")}abc123`);
const base = {
  root,
  tempRoot,
  tempDir,
  packageName: "@umtioaii/astro-harness",
  version: "0.1.0-alpha.3",
};

test("tarball npm usa o nome sanitizado do pacote", () => {
  expect(tarballFileName("@umtioaii/astro-harness", "0.1.0-alpha.3")).toBe(
    "umtioaii-astro-harness-0.1.0-alpha.3.tgz",
  );
  expect(tarballFileName("astro-harness", "1.0.0")).toBe("astro-harness-1.0.0.tgz");
  expect(tempDirPrefix("@umtioaii/astro-harness")).toBe(
    "astro-release-check-umtioaii-astro-harness-",
  );
}, 5000);

test("plano padrão roda qualidade, build, smoke, pack, instalação e help", () => {
  const plan = createPlan(base);

  expect(plan.steps.map((step) => step.id)).toEqual([
    "typecheck",
    "test",
    "build",
    "smoke",
    "pack",
    "install",
    "help",
  ]);
  expect(plan.steps.map((step) => step.display)).toEqual([
    "bun run typecheck",
    "bun test",
    "bun run build",
    "bun run smoke",
    `npm pack --pack-destination ${plan.tempDir}`,
    `npm install --no-save --no-audit --no-fund ${plan.tarball}`,
    "npx --no-install astro --help",
  ]);
  expect(plan.tarball).toBe(
    join(plan.tempDir, "umtioaii-astro-harness-0.1.0-alpha.3.tgz"),
  );
  expect(plan.steps.find((step) => step.id === "install")?.cwd).toBe(plan.tempDir);
  expect(plan.steps.find((step) => step.id === "help")?.cwd).toBe(plan.tempDir);
  expect(plan.steps.some((step) => /publish/.test(`${step.bin} ${step.args.join(" ")}`))).toBe(false);
}, 5000);

test("--skip-tests remove typecheck e bun test do plano", () => {
  const plan = createPlan({ ...base, skipTests: true });

  expect(plan.skipTests).toBe(true);
  expect(plan.steps.map((step) => step.id)).toEqual([
    "build",
    "smoke",
    "pack",
    "install",
    "help",
  ]);
}, 5000);

test("argumentos desconhecidos falham em vez de ignorar", () => {
  expect(parseArgs([])).toEqual({ skipTests: false, json: false, help: false });
  expect(parseArgs(["--skip-tests", "--json"])).toEqual({
    skipTests: true,
    json: true,
    help: false,
  });
  expect(parseArgs(["--help"])).toEqual({ skipTests: false, json: false, help: true });
  expect(() => parseArgs(["--publish"])).toThrow("--publish");
}, 5000);

test("resumo JSON tem forma estável e não carrega saída dos comandos", () => {
  const plan = createPlan(base);
  const results: StepResult[] = [
    { id: "typecheck", status: "passed", exitCode: 0 },
    { id: "test", status: "failed", exitCode: 1 },
    ...plan.steps.slice(2).map((step) => ({ id: step.id, status: "skipped" as const, exitCode: null })),
  ];
  const summary = buildSummary(plan, results, { step: "test", message: "bun test saiu com código 1" });

  expect(Object.keys(summary)).toEqual([
    "ok",
    "packageName",
    "version",
    "skippedTests",
    "tempDir",
    "tarball",
    "steps",
    "failure",
  ]);
  expect(summary.ok).toBe(false);
  expect(summary.steps[1]?.status).toBe("failed");
  expect(summary.steps[2]?.status).toBe("skipped");
  expect(summary.failure?.step).toBe("test");
  expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
}, 5000);

test("falha fecha o gate, marca o resto como skipped e sempre limpa o temporário", () => {
  const plan = createPlan({ ...base, skipTests: true });
  const calls: string[] = [];
  let removed = "";

  const summary = executePlan(plan, {
    spawn: (step) => {
      calls.push(step.id);
      return step.id === "smoke"
        ? { exitCode: 1, output: "SENTINEL-NAO-PODE-VAZAR" }
        : { exitCode: 0, output: "" };
    },
    removeTemp: (dir) => {
      removed = dir;
    },
    log: () => {},
  });

  expect(calls).toEqual(["build", "smoke"]);
  expect(summary.ok).toBe(false);
  expect(summary.failure?.step).toBe("smoke");
  expect(summary.steps.map((step) => step.status)).toEqual([
    "passed",
    "failed",
    "skipped",
    "skipped",
    "skipped",
  ]);
  expect(removed).toBe(plan.tempDir);
  expect(JSON.stringify(summary)).not.toContain("SENTINEL-NAO-PODE-VAZAR");
}, 5000);

test("falha na limpeza também fecha o gate", () => {
  const plan = createPlan({ ...base, skipTests: true });
  const summary = executePlan(plan, {
    spawn: () => ({ exitCode: 0, output: "" }),
    removeTemp: () => {
      throw new Error("sem permissão");
    },
    log: () => {},
  });

  expect(summary.ok).toBe(false);
  expect(summary.failure?.step).toBe("cleanup");
  expect(summary.failure?.message).toContain("sem permissão");
}, 5000);
