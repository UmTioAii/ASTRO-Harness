/**
 * `astro config migrate` (ADR-0028): único escritor da migração de schema.
 * Dry-run por default, `--apply` grava uma vez de forma atômica (tmp + fsync +
 * rename, 0600) e válida origem e destino antes. Nunca imprime valor de config
 * (I-03) e nunca é alcançável por tool, plugin ou `run_command`: é comando CLI.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { globalConfigPath } from "../astro-home";
import { assertLayerSchema } from "../config-overlay";
import { validateProjectLayer } from "../providers/profiles";
import {
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  loadConfigRaw,
  migrateConfigInMemory,
  writeConfigFileAtomic,
} from "./config";

export interface ConfigMigrateReport {
  path: string;
  /** Versão declarada no arquivo; `"0.0.0"` quando ausente (legado). */
  declaredVersion: string;
  versionDeclared: boolean;
  targetVersion: string;
  /** Arquivo já no major suportado: nada a migrar. */
  alreadyCurrent: boolean;
  /** `true` só quando `--apply` gravou o arquivo. */
  written: boolean;
  /** Linhas para o usuário; citam caminho e versão, nunca conteúdo. */
  lines: string[];
}

/** Config global é uma camada parcial por contrato; o projeto é validado inteiro. */
function isGlobalLayer(path: string, env: NodeJS.ProcessEnv): boolean {
  return resolve(path) === resolve(globalConfigPath(env));
}

/**
 * Migra (ou só inspeciona) um config. Sempre valida; arquivo inválido, versão
 * mais nova ou destino symlink falham com `ConfigError` tipado e o arquivo
 * original fica intacto. Segunda execução com `--apply` é no-op.
 */
export function migrateConfigFile(
  path: string,
  options: { apply: boolean; env?: NodeJS.ProcessEnv } = { apply: false },
): ConfigMigrateReport {
  if (!existsSync(path)) {
    throw new ConfigError(
      `configuração não encontrada: "${path}" — crie o arquivo explicitamente ou passe --config com outro caminho`,
      "config_not_found",
    );
  }
  const meta = migrateConfigInMemory(loadConfigRaw(path), { source: path });
  // Valida sempre, mesmo quando não há migração: `--apply` nunca grava config
  // incompatível. A camada de projeto é validada como camada (com global +
  // store), porque um arquivo de first-run pode declarar só `agent.model`; a
  // global é parcial por contrato.
  const env = options.env ?? process.env;
  if (isGlobalLayer(path, env)) {
    assertLayerSchema(meta.document);
  } else {
    validateProjectLayer(meta.document, env, path);
  }
  const from = meta.versionDeclared ? meta.declaredVersion : "ausente (0.0.0)";
  const base = {
    path,
    declaredVersion: meta.declaredVersion,
    versionDeclared: meta.versionDeclared,
    targetVersion: CONFIG_SCHEMA_VERSION,
  };
  if (!meta.changed) {
    return {
      ...base,
      alreadyCurrent: true,
      written: false,
      lines: [`config "${path}": schema ${meta.declaredVersion} (já suportado); nada a migrar`],
    };
  }
  if (!options.apply) {
    return {
      ...base,
      alreadyCurrent: false,
      written: false,
      lines: [
        `config "${path}": schema ${from} -> ${CONFIG_SCHEMA_VERSION} (dry-run); nada foi gravado`,
        "próximo passo: repita com --apply para migrar o arquivo",
      ],
    };
  }
  writeConfigFileAtomic(path, `${JSON.stringify(meta.document, null, 2)}\n`);
  return {
    ...base,
    alreadyCurrent: false,
    written: true,
    lines: [`config "${path}": schema ${from} -> ${CONFIG_SCHEMA_VERSION}; gravado`],
  };
}
