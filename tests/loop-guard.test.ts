import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCheckpoint,
  budgetCheckpointDue,
  checkpointPath,
  continueTask,
  findCheckpointAgents,
  loadCheckpoint,
  ProgressTracker,
  saveCheckpoint,
  turnCheckpointDue,
  type CheckpointV1,
} from "../src/loop-guard";

describe("turnCheckpointDue (L5, #135)", () => {
  test("80% de 100 turnos: due no turno 80, não no 79", () => {
    expect(turnCheckpointDue(80, 100, 0.8)).toBe(true);
    expect(turnCheckpointDue(79, 100, 0.8)).toBe(false);
  });

  test("limite fracionário arredonda para cima (9 turnos × 0.8 = 7.2 → due no 8)", () => {
    expect(turnCheckpointDue(8, 9, 0.8)).toBe(true);
    expect(turnCheckpointDue(7, 9, 0.8)).toBe(false);
  });
});

describe("budgetCheckpointDue (L5, #135)", () => {
  test("80% de $100: due a partir de $80 gastos", () => {
    expect(budgetCheckpointDue(80, 100, 0.8)).toBe(true);
    expect(budgetCheckpointDue(79.99, 100, 0.8)).toBe(false);
  });
});

describe("buildCheckpoint (L5, I-03/I-11, #135)", () => {
  test("sanitiza segredo no resumo e filtra arquivos fora do cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-checkpoint-"));
    const fakeKey = ["s", "k", "-"].join("") + "live-abcdef123456";
    const cp = buildCheckpoint(
      {
        summary: `usei a chave ${fakeKey} no teste`,
        changedFiles: ["src/a.ts", "../fora.ts", join(cwd, "..", "..", "etc", "passwd")],
        nextStep: "rodar bun test",
      },
      cwd,
      new Date("2026-11-01T12:00:00Z"),
    );
    expect(cp.schema).toBe("checkpoint/v1");
    expect(cp.summary).not.toContain(fakeKey); // I-03: segredo nunca no checkpoint
    expect(cp.summary).toContain("[REDACTED]");
    expect(cp.changedFiles).toEqual([join("src", "a.ts")]); // I-11: só caminhos dentro do cwd
    expect(cp.nextStep).toBe("rodar bun test");
    expect(cp.createdAt).toBe("2026-11-01T12:00:00.000Z");
  });

  test("arquivo dentro do cwd via caminho absoluto é mantido como relativo", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-checkpoint-"));
    const cp = buildCheckpoint(
      { summary: "s", changedFiles: [join(cwd, "src", "b.ts")], nextStep: "n" },
      cwd,
      new Date("2026-11-01T12:00:00Z"),
    );
    expect(cp.changedFiles).toEqual([join("src", "b.ts")]);
  });
});

describe("loadCheckpoint (L5, #135)", () => {
  test("lê o checkpoint v1 gravado no store da sessão", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    const cp: CheckpointV1 = {
      schema: "checkpoint/v1",
      summary: "resumo",
      changedFiles: [join("src", "a.ts")],
      nextStep: "rodar testes",
      createdAt: "2026-11-01T12:00:00.000Z",
    };
    saveCheckpoint(cp, checkpointPath(cwd, "run-1", "planner"));
    expect(loadCheckpoint(cwd, "run-1", "planner")).toEqual(cp);
  });

  test("recusa JSON inválido", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    const path = checkpointPath(cwd, "run-1", "planner");
    saveCheckpoint({
      schema: "checkpoint/v1", summary: "s", changedFiles: [], nextStep: "n",
      createdAt: "2026-11-01T12:00:00.000Z",
    }, path);
    writeFileSync(path, "{invalid", "utf8");
    expect(() => loadCheckpoint(cwd, "run-1", "planner")).toThrow(/checkpoint inválido/);
  });

  test("recusa schema desconhecido", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    const path = checkpointPath(cwd, "run-1", "planner");
    saveCheckpoint({
      schema: "checkpoint/v1", summary: "s", changedFiles: [], nextStep: "n",
      createdAt: "2026-11-01T12:00:00.000Z",
    }, path);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...raw, schema: "checkpoint/v2" }), "utf8");
    expect(() => loadCheckpoint(cwd, "run-1", "planner")).toThrow(/schema de checkpoint não suportado/);
  });

  test("recusa arquivo alterado para fora do cwd (I-11)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    const path = checkpointPath(cwd, "run-1", "planner");
    saveCheckpoint({
      schema: "checkpoint/v1", summary: "s", changedFiles: ["../fora.ts"], nextStep: "n",
      createdAt: "2026-11-01T12:00:00.000Z",
    }, path);
    expect(() => loadCheckpoint(cwd, "run-1", "planner")).toThrow(/fora do diretório/);
  });

  test("recusa run/agent com path traversal", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    expect(() => loadCheckpoint(cwd, "../run", "planner")).toThrow(/inválido/);
    expect(() => loadCheckpoint(cwd, "run-1", "../agent")).toThrow(/inválido/);
  });

  test("recusa checkpoint grande demais", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    const path = checkpointPath(cwd, "run-1", "planner");
    saveCheckpoint({
      schema: "checkpoint/v1", summary: "x".repeat(70_000), changedFiles: [], nextStep: "n",
      createdAt: "2026-11-01T12:00:00.000Z",
    }, path);
    expect(() => loadCheckpoint(cwd, "run-1", "planner")).toThrow(/grande demais/);
  });

  test("redige segredo em checkpoint adulterado (I-03)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    const path = checkpointPath(cwd, "run-1", "planner");
    const fakeKey = ["s", "k", "-"].join("") + "live-abcdef123456";
    saveCheckpoint({
      schema: "checkpoint/v1", summary: `chave ${fakeKey}`, changedFiles: [], nextStep: "n",
      createdAt: "2026-11-01T12:00:00.000Z",
    }, path);
    expect(loadCheckpoint(cwd, "run-1", "planner").summary).not.toContain(fakeKey);
    expect(loadCheckpoint(cwd, "run-1", "planner").summary).toContain("[REDACTED]");
  });

  test("erro claro quando o checkpoint não existe", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    expect(() => loadCheckpoint(cwd, "run-1", "planner")).toThrow(/checkpoint não encontrado/);
  });
});

describe("continueTask (L5, #135)", () => {
  const checkpoint: CheckpointV1 = {
    schema: "checkpoint/v1",
    summary: "resumo do progresso",
    changedFiles: [join("src", "a.ts")],
    nextStep: "rodar os testes",
    createdAt: "2026-11-01T12:00:00.000Z",
  };

  test("monta o prompt com resumo, arquivos alterados e próximo passo", () => {
    const prompt = continueTask(checkpoint);
    expect(prompt).toContain("Resumo: resumo do progresso");
    expect(prompt).toContain(join("src", "a.ts"));
    expect(prompt).toContain("Próximo passo: rodar os testes");
  });

  test("tarefa explícita substitui o prompt gerado", () => {
    expect(continueTask(checkpoint, "tarefa nova")).toBe("tarefa nova");
  });

  test("tarefa vazia usa o checkpoint", () => {
    expect(continueTask(checkpoint, "   ")).toContain("Resumo: resumo do progresso");
  });
});

describe("findCheckpointAgents (L5, #135)", () => {
  const checkpoint: CheckpointV1 = {
    schema: "checkpoint/v1",
    summary: "s",
    changedFiles: [],
    nextStep: "n",
    createdAt: "2026-11-01T12:00:00.000Z",
  };

  test("lista os agentes com checkpoint em ordem", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    saveCheckpoint(checkpoint, checkpointPath(cwd, "run-1", "planner"));
    saveCheckpoint(checkpoint, checkpointPath(cwd, "run-1", "coder"));
    mkdirSync(join(cwd, ".astro", "sessions", "run-1", "sem-checkpoint"), { recursive: true });
    expect(findCheckpointAgents(cwd, "run-1")).toEqual(["coder", "planner"]);
  });

  test("run sem checkpoint devolve vazio", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    expect(findCheckpointAgents(cwd, "run-1")).toEqual([]);
  });

  test("run inválido é recusado", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-continue-"));
    expect(() => findCheckpointAgents(cwd, "../run")).toThrow(/inválido/);
  });
});

describe("ProgressTracker (L6, #135)", () => {
  test("3 segmentos seguidos com o mesmo hash → sem progresso (pausa)", () => {
    const tracker = new ProgressTracker(3);
    expect(tracker.record("aaa")).toBe(false);
    expect(tracker.record("aaa")).toBe(false);
    expect(tracker.record("aaa")).toBe(true);
  });

  test("hash diferente reseta a contagem", () => {
    const tracker = new ProgressTracker(3);
    tracker.record("aaa");
    tracker.record("aaa");
    expect(tracker.record("bbb")).toBe(false);
    expect(tracker.record("bbb")).toBe(false);
    expect(tracker.record("bbb")).toBe(true);
  });
});
