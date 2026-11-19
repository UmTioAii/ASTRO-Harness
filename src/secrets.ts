/** Predicados de header/credencial compartilhados por config, store e plugins (I-03). */
import { redactSecrets } from "./sanitize-external";

const AUTH_HEADER = /(^|-)authorization$|(^|-)api[-_]?key$|(^|-)key$|(^|-)secret$|^cookie$|^set-cookie$|^x-auth(-|$)|token$/;
/** Headers que terminam em `-key` mas são metadado, não credencial. */
const METADATA_KEY_HEADERS = new Set(["idempotency-key", "x-idempotency-key"]);
const SECRET_VALUE = /^(sk-|nvapi-|AIza|ghp_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|eyJ[\w-]+\.[\w-]+\.)/;
/** `Bearer token`/`Basic base64` com token único; prosa ("Basic authentication required") não conta. */
const AUTH_SCHEME = /^(bearer|basic)\s+\S{6,}$/i;

export function isAuthHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (METADATA_KEY_HEADERS.has(lower)) return false;
  return AUTH_HEADER.test(lower);
}

export function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  if (AUTH_SCHEME.test(trimmed)) return true;
  const text = trimmed.replace(/^(bearer|basic)\s+/i, "");
  return SECRET_VALUE.test(text);
}

/**
 * Nome de variável que carrega segredo (mesma vocabulário da sanitização do
 * `run_command`): KEY, TOKEN, SECRET, PASSWORD, PEM, AUTH, CREDENTIAL…
 * Identidade git é exceção explícita.
 */
const SECRET_ENV_NAME =
  /(^|_)[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PASSPHRASE|PEM|AUTH|CREDENTIAL|PRIVATE|COOKIE|SESSION)[A-Z0-9_]*$/i;
const NON_SECRET_ENV = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_EMAIL",
]);

export function isSecretEnvName(name: string): boolean {
  return !NON_SECRET_ENV.has(name.toUpperCase()) && SECRET_ENV_NAME.test(name);
}

/** Valor com segredo em qualquer posição (prefixo, `chave=valor`, PEM, JWT, hex longo). */
function containsSecret(value: string): boolean {
  return looksLikeSecret(value) || redactSecrets(value) !== value;
}

/** Arg com segredo: valor prefixado ou embutido em `--flag=valor` / `CHAVE=valor`. */
function argHasSecret(arg: string): boolean {
  if (containsSecret(arg)) return true;
  const eq = arg.indexOf("=");
  if (eq <= 0) return false;
  const flag = arg.slice(0, eq).trim().replace(/^-+/, "");
  return isSecretEnvName(flag) || containsSecret(arg.slice(eq + 1));
}

/**
 * Campo de `mcpServers` com segredo (#496): `env.CHAVE` (nome ou valor) ou
 * `args[i]`. Devolve só o caminho do campo, nunca o valor (I-03).
 */
export function mcpSecretProblem(mcpServers: unknown): string | undefined {
  if (typeof mcpServers !== "object" || mcpServers === null) return undefined;
  for (const [name, server] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (typeof server !== "object" || server === null) continue;
    const record = server as Record<string, unknown>;
    if (Array.isArray(record.args)) {
      const index = record.args.findIndex((arg) => typeof arg === "string" && argHasSecret(arg));
      if (index >= 0) return `mcpServers.${name}.args[${index}]`;
    }
    if (typeof record.env === "object" && record.env !== null && !Array.isArray(record.env)) {
      for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
        if (isSecretEnvName(key)) return `mcpServers.${name}.env.${key}`;
        if (typeof value === "string" && containsSecret(value)) return `mcpServers.${name}.env.${key}`;
      }
    }
  }
  return undefined;
}

/** Prefixo de `credentialRef` que aponta para o cofre local (ADR-0019). */
export const VAULT_REF_PREFIX = "vault:";
/** Id de credencial do cofre: `cred-<uuid>`. */
const VAULT_ID = /^cred-[A-Za-z0-9-]{8,}$/;

export function isVaultRef(value: string): boolean {
  return value.startsWith(VAULT_REF_PREFIX);
}

export function isVaultId(value: string): boolean {
  return VAULT_ID.test(value);
}

/** `vault:<credentialId>` bem formado; o id é público, o valor nunca (I-03). */
export function isVaultCredentialRef(value: string): boolean {
  return isVaultRef(value) && isVaultId(value.slice(VAULT_REF_PREFIX.length));
}

/** Nome de variável de ambiente (fonte de segredo nomeada, I-03). */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function isEnvName(value: string): boolean {
  return ENV_NAME.test(value);
}
