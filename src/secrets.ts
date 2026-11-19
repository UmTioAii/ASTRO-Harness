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

/** Regra ampla (fail-safe) para *remover* variáveis do host dos filhos. */
export function isSecretEnvName(name: string): boolean {
  return !NON_SECRET_ENV.has(name.toUpperCase()) && SECRET_ENV_NAME.test(name);
}

/** Último segmento que nomeia credencial (`API_KEY`, `DB_PASSWORD`, `GITHUB_TOKEN`…). */
const CREDENTIAL_SEGMENT = new Set(["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "PEM", "CREDENTIAL"]);
/** Nomes inteiros que são credencial por si (`AUTH`, `COOKIE`…) — `AUTH_MODE` fica de fora. */
const CREDENTIAL_NAME_EXACT = new Set(["AUTH", "COOKIE", "SESSION", "PASS", "CREDENTIALS"]);
/** Qualificadores de metadado antes do segmento de credencial (`BYTES_PER_TOKEN`, `TOKEN_LIMIT`…). */
const NON_CREDENTIAL_QUALIFIERS = new Set([
  "PER", "LIMIT", "COUNT", "MAX", "MIN", "SIZE", "LENGTH", "RATE", "TIMEOUT", "TYPE", "MODE", "PATH", "ENDPOINT", "NAME", "LEN", "TTL",
]);

/**
 * Nome de campo de config que *é* credencial (#496): o último segmento
 * (`_`/`-`) é KEY/TOKEN/SECRET/PASSWORD… ou o nome inteiro é AUTH/COOKIE.
 * Mais estreito que `isSecretEnvName` para não recusar metadado legítimo
 * (`AUTH_MODE`, `TOKEN_ENDPOINT`, `BYTES_PER_TOKEN`) — heurístico, como headers.
 */
export function isCredentialEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (NON_SECRET_ENV.has(upper)) return false;
  if (CREDENTIAL_NAME_EXACT.has(upper)) return true;
  const segments = upper.split(/[_-]/);
  const last = segments[segments.length - 1];
  if (last === undefined) return false;
  const credential = CREDENTIAL_SEGMENT.has(last) || upper.endsWith("PRIVATE_KEY");
  if (!credential) return false;
  const previous = segments[segments.length - 2];
  return previous === undefined || !NON_CREDENTIAL_QUALIFIERS.has(previous);
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
  return isCredentialEnvName(flag) || containsSecret(arg.slice(eq + 1));
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
      for (let index = 0; index < record.args.length; index++) {
        const arg = record.args[index];
        if (typeof arg !== "string") continue;
        // `--api-key <valor>`: o alvo é o valor, não a flag.
        const flag = arg.startsWith("-") && !arg.includes("=") ? arg.replace(/^-+/, "") : undefined;
        if (flag !== undefined && isCredentialEnvName(flag)) {
          return `mcpServers.${name}.args[${index + 1 < record.args.length ? index + 1 : index}]`;
        }
        if (argHasSecret(arg)) return `mcpServers.${name}.args[${index}]`;
      }
    }
    if (typeof record.env === "object" && record.env !== null && !Array.isArray(record.env)) {
      for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
        if (isCredentialEnvName(key)) return `mcpServers.${name}.env.${key}`;
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
