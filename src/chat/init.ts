/** `/init` + first-run da TUI: cria arquivos iniciais sem sobrescrever (`wx`). */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalConfigPath } from "../astro-home";
import { isPlainObject, loadConfigRaw } from "../core/config";

export const AGENTS_TEMPLATE = `# AGENTS

## Projeto

Descreva o objetivo e o que este repositório entrega.

## Comandos

- instalar:
- testar:
- typecheck:

## Regras

- Nenhum segredo em log, erro, commit ou prompt.
- Mudança de comportamento exige teste que falha antes e passa depois.
- Caminhos ficam dentro do diretório de trabalho.

## Não fazer

- Não criar arquivo de estado de projeto.
`;

export function initAgents(cwd: string): string {
  const path = join(cwd, "AGENTS.md");
  try {
    writeFileSync(path, AGENTS_TEMPLATE, { encoding: "utf8", flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("AGENTS.md já existe; nada foi alterado");
    }
    throw error;
  }
  return path;
}

/** Template do `config.json` global criado no first-run (#559): vazio; providers entram depois via store. */
export const GLOBAL_CONFIG_TEMPLATE = "{}\n";

/** Cria `path` com `contents` só se não existir (`wx`, 0600); EEXIST devolve false. */
function createFileExclusive(path: string, contents: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, contents, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`não foi possível criar "${path}"${code === undefined ? "" : ` (${code})`} — nada foi alterado`);
  }
}

/**
 * Modelo ativo da camada global crua (`activeProfileId` ou primeiro provider),
 * no formato `provider/id`; `undefined` quando não dá para derivar (global
 * ausente/inválido/sem providers) — nesse caso não existe config de projeto
 * válida para gravar (#559).
 */
function activeModelRefFromGlobal(raw: Record<string, unknown>): string | undefined {
  const providers = isPlainObject(raw.providers) ? raw.providers : undefined;
  if (providers === undefined) return undefined;
  const active = typeof raw.activeProfileId === "string" && isPlainObject(providers[raw.activeProfileId])
    ? raw.activeProfileId
    : Object.keys(providers)[0];
  if (active === undefined) return undefined;
  const models = Array.isArray(raw.models) ? raw.models : [];
  const model = models.find((entry): entry is Record<string, unknown> => (
    isPlainObject(entry) && entry.provider === active && typeof entry.id === "string"
  ));
  return model === undefined ? undefined : `${active}/${model.id as string}`;
}

export interface FirstRunConfigResult {
  projectCreated: boolean;
  globalCreated: boolean;
}

/**
 * First-run da TUI (#559): com config implícita (`allowMissing`), garante o
 * `config.json` global (template vazio, `wx` 0600) e cria o
 * `astro.config.json` se ausente **e** houver um modelo derivável na camada
 * global — o template grava só `agent.model` (nada de `preset`/`mode`, para
 * nunca alargar o global, ADR-0029; sem segredo, I-03). Sem provider ainda,
 * o projeto não é criado aqui: o setup de provider cria os dois juntos.
 * Nunca sobrescreve (`wx`); `ASTRO_NO_GLOBAL_CONFIG=1` desliga o global e,
 * sem camada global, também o projeto. Com `--config` explícito
 * (`allowMissing=false`) não cria nada. O chamador trata falha como aviso: o
 * boot segue em zero-config.
 */
export function ensureFirstRunConfig(
  configPath: string,
  opts: { env?: NodeJS.ProcessEnv; allowMissing?: boolean } = {},
): FirstRunConfigResult {
  if (opts.allowMissing !== true) return { projectCreated: false, globalCreated: false };
  const env = opts.env ?? process.env;
  let globalCreated = false;
  if (env.ASTRO_NO_GLOBAL_CONFIG !== "1") {
    const globalPath = globalConfigPath(env);
    if (!existsSync(globalPath)) {
      mkdirSync(dirname(globalPath), { recursive: true, mode: 0o700 });
      globalCreated = createFileExclusive(globalPath, GLOBAL_CONFIG_TEMPLATE);
    }
  }
  let projectCreated = false;
  if (!existsSync(configPath) && env.ASTRO_NO_GLOBAL_CONFIG !== "1") {
    let modelRef: string | undefined;
    try {
      const globalPath = globalConfigPath(env);
      if (existsSync(globalPath)) modelRef = activeModelRefFromGlobal(loadConfigRaw(globalPath));
    } catch {
      modelRef = undefined; // global ilegível: não arrisca gravar projeto inválido
    }
    if (modelRef !== undefined) {
      projectCreated = createFileExclusive(configPath, `${JSON.stringify({ agent: { model: modelRef } }, null, 2)}\n`);
    }
  }
  return { projectCreated, globalCreated };
}
