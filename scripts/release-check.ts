/**
 * Gate local de release: roda qualidade opcional (typecheck + bun test), build,
 * smoke, `npm pack`, instala o tarball em um diretório temporário limpo e valida
 * `npx astro --help`. Nunca publica, nunca imprime saída sem redigir segredos e
 * falha fechado em qualquer erro, inclusive na limpeza.
 *
 * Uso: bun scripts/release-check.ts [--skip-tests] [--json]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../src/sanitize-external";

export type StepId = "typecheck" | "test" | "build" | "smoke" | "pack" | "install" | "help";
export type StepStatus = "passed" | "failed" | "skipped";

export interface PlannedStep {
  id: StepId;
  label: string;
  /** Executável lógico; resolvido com `Bun.which` na execução. */
  bin: string;
  args: string[];
  cwd: string;
  /** Linha exibida ao usuário; nunca contém segredo. */
  display: string;
}

export interface ReleasePlan {
  root: string;
  tempRoot: string;
  tempDir: string;
  tarball: string;
  packageName: string;
  version: string;
  skipTests: boolean;
  steps: PlannedStep[];
}

export interface StepResult {
  id: StepId;
  status: StepStatus;
  exitCode: number | null;
}

export interface Failure {
  step: string;
  message: string;
}

export interface ReleaseSummary {
  ok: boolean;
  packageName: string;
  version: string;
  skippedTests: boolean;
  tempDir: string;
  tarball: string;
  steps: Array<{ id: StepId; command: string; status: StepStatus; exitCode: number | null }>;
  failure: Failure | null;
}

export interface CliOptions {
  skipTests: boolean;
  json: boolean;
  help: boolean;
}

export interface PackageMeta {
  name: string;
  version: string;
}

export interface PlanInput {
  root: string;
  tempRoot: string;
  tempDir: string;
  packageName: string;
  version: string;
  skipTests?: boolean;
}

export interface StepOutcome {
  exitCode: number | null;
  output?: string;
  error?: string;
}

export interface ExecuteOptions {
  spawn?: (step: PlannedStep) => StepOutcome;
  removeTemp?: (dir: string) => void;
  log?: (line: string) => void;
}

const TEMP_PREFIX = "astro-release-check-";
const STEP_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_CHARS = 8_000;

const USAGE = `Uso: bun scripts/release-check.ts [--skip-tests] [--json]

Gate local de release. Não publica nada.
  --skip-tests  pula typecheck e bun test; build, smoke, pack e instalação continuam
  --json        imprime só o resumo JSON ao final
  --help        mostra esta ajuda

Passos manuais fora do gate (TUI e provider não são automatizáveis headless):
  1. npm install -g @umtioai/astro-harness@alpha
  2. astro tui`;

/** Nome de arquivo que o `npm pack` gera para nome+versão do pacote. */
export function packageSlug(name: string): string {
  const slug = name
    .replace(/^@/, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (slug === "") throw new Error("nome de pacote inválido para o tarball");
  return slug;
}

export function tarballFileName(name: string, version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) || version.includes("..")) {
    throw new Error("versão de pacote inválida para o tarball");
  }
  return `${packageSlug(name)}-${version}.tgz`;
}

export function tempDirPrefix(name: string): string {
  return `${TEMP_PREFIX}${packageSlug(name)}-`;
}

function quoteDisplay(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function createPlan(input: PlanInput): ReleasePlan {
  if (!isInside(input.tempRoot, input.tempDir)) {
    throw new Error(`diretório temporário fora da raiz permitida: ${input.tempDir}`);
  }
  if (!basename(input.tempDir).startsWith(TEMP_PREFIX)) {
    throw new Error(`diretório temporário sem o prefixo ${TEMP_PREFIX}: ${input.tempDir}`);
  }

  const tarball = join(input.tempDir, tarballFileName(input.packageName, input.version));
  const steps: PlannedStep[] = [];

  if (input.skipTests !== true) {
    steps.push({
      id: "typecheck",
      label: "typecheck",
      bin: "bun",
      args: ["run", "typecheck"],
      cwd: input.root,
      display: "bun run typecheck",
    });
    steps.push({
      id: "test",
      label: "testes",
      bin: "bun",
      args: ["test"],
      cwd: input.root,
      display: "bun test",
    });
  }

  steps.push({
    id: "build",
    label: "build",
    bin: "bun",
    args: ["run", "build"],
    cwd: input.root,
    display: "bun run build",
  });
  steps.push({
    id: "smoke",
    label: "smoke",
    bin: "bun",
    args: ["run", "smoke"],
    cwd: input.root,
    display: "bun run smoke",
  });
  steps.push({
    id: "pack",
    label: "empacotar",
    bin: "npm",
    args: ["pack", "--pack-destination", input.tempDir],
    cwd: input.root,
    display: `npm pack --pack-destination ${quoteDisplay(input.tempDir)}`,
  });
  steps.push({
    id: "install",
    label: "instalar tarball em diretório limpo",
    bin: "npm",
    args: ["install", "--no-save", "--no-audit", "--no-fund", tarball],
    cwd: input.tempDir,
    display: `npm install --no-save --no-audit --no-fund ${quoteDisplay(tarball)}`,
  });
  steps.push({
    id: "help",
    label: "astro --help no pacote instalado",
    bin: "npx",
    args: ["--no-install", "astro", "--help"],
    cwd: input.tempDir,
    display: "npx --no-install astro --help",
  });

  return {
    root: input.root,
    tempRoot: input.tempRoot,
    tempDir: input.tempDir,
    tarball,
    packageName: input.packageName,
    version: input.version,
    skipTests: input.skipTests === true,
    steps,
  };
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { skipTests: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--skip-tests") options.skipTests = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`argumento desconhecido: ${arg}`);
  }
  return options;
}

export function readPackageMeta(root: string): PackageMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    throw new Error("package.json ausente ou inválido");
  }
  const manifest = parsed as { name?: unknown; version?: unknown };
  if (typeof manifest.name !== "string" || !/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(manifest.name)) {
    throw new Error("package.json sem nome de pacote válido");
  }
  if (typeof manifest.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(manifest.version)) {
    throw new Error("package.json sem versão válida");
  }
  return { name: manifest.name, version: manifest.version };
}

export function prepareTempDir(tempRoot: string, packageName: string): string {
  const dir = mkdtempSync(join(tempRoot, tempDirPrefix(packageName)));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "astro-release-check", private: true }, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

export function removeTempDir(tempRoot: string, tempDir: string): void {
  if (!isInside(tempRoot, tempDir) || !basename(tempDir).startsWith(TEMP_PREFIX)) {
    throw new Error(`recusando remover diretório temporário fora do padrão: ${tempDir}`);
  }
  rmSync(tempDir, { recursive: true, force: true });
}

/** Últimas linhas da saída, com segredos redigidos e tamanho limitado. */
export function tailForFailure(output: string, maxLines = 40): string {
  const raw = output.length > MAX_OUTPUT_CHARS * 2 ? output.slice(-MAX_OUTPUT_CHARS * 2) : output;
  const redacted = redactSecrets(raw);
  const clipped = redacted.length > MAX_OUTPUT_CHARS ? redacted.slice(-MAX_OUTPUT_CHARS) : redacted;
  return clipped.trimEnd().split(/\r?\n/).slice(-maxLines).join("\n");
}

function commandFor(plan: ReleasePlan, id: StepId): string {
  return plan.steps.find((step) => step.id === id)?.display ?? "";
}

export function buildSummary(
  plan: ReleasePlan,
  results: readonly StepResult[],
  failure: Failure | null,
): ReleaseSummary {
  return {
    ok: failure === null,
    packageName: plan.packageName,
    version: plan.version,
    skippedTests: plan.skipTests,
    tempDir: plan.tempDir,
    tarball: plan.tarball,
    steps: results.map((result) => ({
      id: result.id,
      command: commandFor(plan, result.id),
      status: result.status,
      exitCode: result.exitCode,
    })),
    failure,
  };
}

function runPlannedStep(step: PlannedStep): StepOutcome {
  const bin = Bun.which(step.bin);
  if (bin === null) {
    return { exitCode: null, output: "", error: `comando não encontrado: ${step.bin}` };
  }
  try {
    const proc = Bun.spawnSync({
      cmd: [bin, ...step.args],
      cwd: step.cwd,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: STEP_TIMEOUT_MS,
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}\n${proc.stderr.toString()}`,
    };
  } catch (error) {
    return {
      exitCode: null,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Executa o plano em ordem, para na primeira falha e sempre tenta limpar. */
export function executePlan(plan: ReleasePlan, options: ExecuteOptions = {}): ReleaseSummary {
  const spawn = options.spawn ?? runPlannedStep;
  const removeTemp = options.removeTemp
    ?? ((dir: string) => removeTempDir(plan.tempRoot, dir));
  const log = options.log ?? (() => {});

  const results: StepResult[] = [];
  let failure: Failure | null = null;

  plan.steps.forEach((step, index) => {
    if (failure !== null) {
      results.push({ id: step.id, status: "skipped", exitCode: null });
      log(`[${index + 1}/${plan.steps.length}] ${step.display} ... pulado`);
      return;
    }

    log(`[${index + 1}/${plan.steps.length}] ${step.display}`);
    let outcome: StepOutcome;
    try {
      outcome = spawn(step);
    } catch (error) {
      outcome = {
        exitCode: null,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.exitCode === 0) {
      results.push({ id: step.id, status: "passed", exitCode: 0 });
      log("  ok");
      return;
    }

    const message = outcome.error !== undefined
      ? redactSecrets(outcome.error)
      : outcome.exitCode === null
        ? `${step.display} terminou sem código de saída (timeout ou sinal)`
        : `${step.display} saiu com código ${outcome.exitCode}`;
    results.push({ id: step.id, status: "failed", exitCode: outcome.exitCode });
    failure = { step: step.id, message };
    log(`  falhou: ${message}`);

    const tail = tailForFailure(outcome.output ?? "");
    if (tail !== "") log(tail.split("\n").map((line) => `  ${line}`).join("\n"));
  });

  try {
    removeTemp(plan.tempDir);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    if (failure === null) failure = { step: "cleanup", message };
    else log(`  aviso: falha ao limpar ${plan.tempDir}: ${message}`);
  }

  return buildSummary(plan, results, failure);
}

function main(): number {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    console.error(`release-check: ${message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const root = resolve(import.meta.dir, "..");
  let meta: PackageMeta | undefined;
  let tempDir: string | undefined;
  try {
    meta = readPackageMeta(root);
    const tempRoot = tmpdir();
    tempDir = prepareTempDir(tempRoot, meta.name);
    const plan = createPlan({
      root,
      tempRoot,
      tempDir,
      packageName: meta.name,
      version: meta.version,
      skipTests: options.skipTests,
    });

    if (!options.json) {
      console.log(`release-check: ${meta.name}@${meta.version}`);
      console.log(`release-check: temporário ${tempDir}`);
    }

    const summary = executePlan(plan, {
      log: options.json ? () => {} : (line) => console.log(line),
    });

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else if (summary.ok) {
      console.log(`release-check: ok (${summary.steps.length} etapas)`);
    } else {
      console.error(`release-check: falhou em ${summary.failure?.step ?? "etapa desconhecida"}`);
    }
    return summary.ok ? 0 : 1;
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    if (tempDir !== undefined) {
      try {
        removeTempDir(tmpdir(), tempDir);
      } catch {
        // A falha principal já fecha o gate; não esconder a causa original.
      }
    }
    if (options.json) {
      console.log(JSON.stringify({
        ok: false,
        packageName: meta?.name ?? "",
        version: meta?.version ?? "",
        skippedTests: options.skipTests,
        tempDir: tempDir ?? "",
        tarball: "",
        steps: [],
        failure: { step: "setup", message },
      }, null, 2));
    } else {
      console.error(`release-check: ${message}`);
    }
    return 1;
  }
}

if (import.meta.main) process.exit(main());
