import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./astro-home";
import { looksLikeSecret } from "./secrets";

export interface AstroHomeState {
  version: 1;
  trust: { folders: string[] };
  migrations: { providers: boolean; trust: boolean };
}

const EMPTY_STATE: AstroHomeState = {
  version: 1,
  trust: { folders: [] },
  migrations: { providers: false, trust: false },
};

function validateHomeState(value: unknown): AstroHomeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("estado global inválido: raiz deve ser um objeto");
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => !["version", "trust", "migrations"].includes(key))) {
    throw new Error("estado global inválido: campo desconhecido");
  }
  if (root.version !== 1) throw new Error('estado global inválido: "version" deve ser 1');
  if (typeof root.trust !== "object" || root.trust === null || Array.isArray(root.trust)) {
    throw new Error('estado global inválido: "trust" deve ser um objeto');
  }
  const trust = root.trust as Record<string, unknown>;
  if (Object.keys(trust).some((key) => key !== "folders") || !Array.isArray(trust.folders)) {
    throw new Error('estado global inválido: "trust.folders" deve ser uma lista');
  }
  const folders = trust.folders.map((folder) => {
    if (typeof folder !== "string" || folder.trim() === "" || looksLikeSecret(folder)) {
      throw new Error('estado global inválido: "trust.folders" contém entrada inválida');
    }
    return folder;
  });
  if (typeof root.migrations !== "object" || root.migrations === null || Array.isArray(root.migrations)) {
    throw new Error('estado global inválido: "migrations" deve ser um objeto');
  }
  const migrations = root.migrations as Record<string, unknown>;
  if (
    Object.keys(migrations).some((key) => !["providers", "trust"].includes(key))
    || typeof migrations.providers !== "boolean"
    || typeof migrations.trust !== "boolean"
  ) {
    throw new Error("estado global inválido: migrações inválidas");
  }
  return {
    version: 1,
    trust: { folders: [...new Set(folders)] },
    migrations: { providers: migrations.providers, trust: migrations.trust },
  };
}

export function loadHomeState(path: string = statePath()): AstroHomeState {
  if (!existsSync(path)) return structuredClone(EMPTY_STATE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`estado global inválido em "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`estado global inválido em "${path}": JSON inválido`);
  }
  try {
    return validateHomeState(parsed);
  } catch (error) {
    throw new Error(`estado global inválido em "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveHomeState(state: AstroHomeState, path: string = statePath()): void {
  const valid = validateHomeState(state);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}
