/** Resumo da config do harness para `/config` (#273): puro, sem I/O. */
import type { AstroConfig, BudgetConfig } from "../core/config";
import type { EditableConfigKey } from "../core/config-edit";
import { DEFAULT_APPROVAL_TIMEOUT_MS, type PermissionMode } from "../permissions";

export interface CostLine {
  /** Modelo `provider/id`. */
  ref: string;
  inputPerM: number;
  outputPerM: number;
}

export interface ConfigSummary {
  configPath: string;
  /** Limite único de trabalho em passos por tarefa (`agent.maxSteps`). */
  maxSteps: number;
  permissionMode: PermissionMode;
  /** `permissions.approvalTimeoutMs` como texto; `0` = desligado (#526). */
  approvalTimeoutMs: string;
  /** Um linha por modelo com preço declarado (`pricing` sobrescreve `model.price`). */
  costs: CostLine[];
  budget: string;
  /** Valores atuais dos knobs editáveis via /config (#558), como texto. */
  knobs: { key: EditableConfigKey; value: string }[];
}

function budgetText(budget: BudgetConfig | undefined): string {
  if (budget === undefined) return "sem budget";
  const limit = budget.limitUsd === null
    ? "sem limite (use-as-you-go)"
    : `US$ ${budget.limitUsd.toFixed(2)}`;
  const ceiling = budget.hardCeilingUsd === undefined
    ? ""
    : ` · teto US$ ${budget.hardCeilingUsd.toFixed(2)}`;
  return `${budget.scope} · limite ${limit} · aviso em ${Math.round(budget.warnAt * 100)}% · ao exceder: ${budget.onExceed}${ceiling}`;
}

/** Texto do teto de aprovação (#526): ausente usa o default do executor; `0` desliga. */
function approvalTimeoutText(value: number | undefined): string {
  if (value === undefined) return `${DEFAULT_APPROVAL_TIMEOUT_MS} (default)`;
  return value === 0 ? "desligado" : String(value);
}

/** Knobs editáveis com o valor atual na config (seção ausente = knob não listado). */
function knobEntries(config: AstroConfig): { key: EditableConfigKey; value: string }[] {
  const fmt = (value: number | null): string => (value === null ? "null" : String(value));
  const knobs: { key: EditableConfigKey; value: string }[] = [
    { key: "preset", value: config.preset },
    ...(config.preset === "control" ? [
      { key: "run.maxTurns" as const, value: String(config.run?.maxTurns ?? 500) },
      { key: "run.maxRoundsPerTurn" as const, value: String(config.run?.maxRoundsPerTurn ?? config.agent.maxSteps) },
    ] : []),
    { key: "permissions.mode", value: config.permissions.mode },
  ];
  const budget = config.budget;
  if (budget !== undefined) {
    knobs.push(
      { key: "budget.scope", value: budget.scope },
      { key: "budget.limitUsd", value: fmt(budget.limitUsd) },
      { key: "budget.warnAt", value: String(budget.warnAt) },
      { key: "budget.onExceed", value: budget.onExceed },
      ...(budget.hardCeilingUsd === undefined
        ? []
        : [{ key: "budget.hardCeilingUsd" as const, value: fmt(budget.hardCeilingUsd) }]),
    );
  }
  const team = config.team;
  if (team !== undefined) {
    for (const name of ["projectBudgetUsd", "sessionBudgetUsd", "weekBudgetUsd"] as const) {
      const value = team[name];
      if (value !== undefined) knobs.push({ key: `team.${name}` as EditableConfigKey, value: fmt(value) });
    }
  }
  return knobs;
}

/** Monta o resumo a partir da config carregada; `mode` é o modo ativo da sessão. */
export function configSummaryOf(config: AstroConfig, configPath: string, mode: PermissionMode): ConfigSummary {
  const costs: CostLine[] = [];
  for (const model of config.models) {
    const ref = `${model.provider}/${model.id}`;
    const price = config.pricing?.[ref] ?? model.price; // pricing global vence model.price (C6)
    if (price === undefined) continue;
    costs.push({ ref, inputPerM: price.inputPerM, outputPerM: price.outputPerM });
  }
  return {
    configPath,
    maxSteps: config.agent.maxSteps,
    permissionMode: mode,
    approvalTimeoutMs: approvalTimeoutText(config.permissions.approvalTimeoutMs),
    costs,
    budget: budgetText(config.budget),
    knobs: knobEntries(config),
  };
}

/** Linhas exibidas no REPL (`/config`) e na tela da TUI. */
export function configLines(summary: ConfigSummary, trustedFolders: readonly string[]): string[] {
  const money = (value: number): string => `US$ ${value.toFixed(2)}/M`;
  return [
    `config: ${summary.configPath}`,
    ...summary.knobs.flatMap(({ key, value }) => key === "run.maxTurns" || key === "run.maxRoundsPerTurn" ? [`${key}: ${value}`] : []),
    `permissions.mode: ${summary.permissionMode}`,
    `permissions.approvalTimeoutMs: ${summary.approvalTimeoutMs}`,
    `budget: ${summary.budget}`,
    ...(summary.costs.length === 0
      ? ["custos: nenhum preço declarado"]
      : [
          "custos por modelo:",
          ...summary.costs.map((cost) => `  ${cost.ref}: in ${money(cost.inputPerM)} · out ${money(cost.outputPerM)}`),
        ]),
    ...(trustedFolders.length === 0
      ? ["pastas confiáveis: nenhuma"]
      : ["pastas confiáveis:", ...trustedFolders.map((folder) => `  ${folder}`)]),
  ];
}
