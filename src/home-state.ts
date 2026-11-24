import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./astro-home";
import { looksLikeSecret } from "./secrets";

/** A consent record (#479, #599): only the short version and the ISO date, no credential or personal data. */
export interface ConsentRecord {
  version: string;
  acceptedAt: string;
}

/** Terms acceptance (#479); the shape is shared with the shell-risk consent (#599). */
export type TermsAcceptance = ConsentRecord;

export interface AstroHomeState {
  version: 1;
  trust: { folders: string[] };
  migrations: { providers: boolean; trust: boolean };
  terms?: ConsentRecord;
  /** Shell-risk consent (#599), recorded next to the terms acceptance. */
  shell?: ConsentRecord;
}

const EMPTY_STATE: AstroHomeState = {
  version: 1,
  trust: { folders: [] },
  migrations: { providers: false, trust: false },
};

/**
 * Estado global que não pode ser criado nem gravado (ex.: `$ASTRO_HOME`
 * apontando para um arquivo, diretório sem permissão, destino ocupado por um
 * diretório). Erro tipado que cita só o diretório: a mensagem crua do `mkdir`
 * duplica o `code` e vaza jargão (`EEXIST: ... mkdir`), e a do `write`/`rename`
 * nomeia um `.tmp` que o usuário nunca viu. Fail-closed: nada é gravado,
 * nenhum `.tmp` fica para trás.
 */
export class HomeStateUnwritableError extends Error {
  readonly code = "state_unwritable";
  constructor(readonly path: string, readonly step: "create" | "write" = "create") {
    super(`estado global não gravável em "${path}": ${step === "create"
      ? "o diretório não pode ser criado"
      : "o estado não pode ser gravado"}`);
    this.name = "HomeStateUnwritableError";
  }
}

/** Versão curta e opaca; a data é o `toISOString()` do aceite. */
const CONSENT_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** One consent record; `field` names it in the error, and the value is never echoed. */
function validateConsent(value: unknown, field: "terms" | "shell"): ConsentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`estado global inválido: "${field}" deve ser um objeto`);
  }
  const record = value as Record<string, unknown>;
  // Campo desconhecido é erro, nunca ignorado: o registro guarda só versão e data.
  if (Object.keys(record).some((key) => key !== "version" && key !== "acceptedAt")) {
    throw new Error(`estado global inválido: "${field}" contém campo desconhecido`);
  }
  if (typeof record.version !== "string" || !CONSENT_VERSION_PATTERN.test(record.version)) {
    throw new Error(`estado global inválido: "${field}.version" deve ser uma versão curta`);
  }
  if (
    typeof record.acceptedAt !== "string"
    || !ISO_DATE_PATTERN.test(record.acceptedAt)
    || Number.isNaN(Date.parse(record.acceptedAt))
  ) {
    throw new Error(`estado global inválido: "${field}.acceptedAt" deve ser uma data ISO`);
  }
  return { version: record.version, acceptedAt: record.acceptedAt };
}

function validateHomeState(value: unknown): AstroHomeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("estado global inválido: raiz deve ser um objeto");
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => !["version", "trust", "migrations", "terms", "shell"].includes(key))) {
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
  let terms: ConsentRecord | undefined;
  if (root.terms !== undefined) {
    terms = validateConsent(root.terms, "terms");
  }
  const shell = root.shell === undefined ? undefined : validateConsent(root.shell, "shell");
  return {
    version: 1,
    trust: { folders: [...new Set(folders)] },
    migrations: { providers: migrations.providers, trust: migrations.trust },
    ...(terms === undefined ? {} : { terms }),
    ...(shell === undefined ? {} : { shell }),
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
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new HomeStateUnwritableError(dir);
  }
  // `mode` do `mkdirSync` é ignorado quando o diretório já existe, e outro módulo
  // pode ter criado o `$ASTRO_HOME` com 0755: ajusta em melhor esforço, como `saveVault`.
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* melhor esforço */ }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } catch {
    try { unlinkSync(temporary); } catch {}
    // Diretório existe mas não aceita a escrita (sem permissão, destino ocupado
    // por um diretório): mesma falha tipada, citando só o diretório e sem `.tmp`.
    throw new HomeStateUnwritableError(dir, "write");
  }
}
