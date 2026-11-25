/**
 * TUI boot credential recovery (#616): a saved provider whose active credential
 * no longer resolves gets the credential step before the first prompt, keeping
 * provider and model; messages name the ref, never a value (I-03).
 */
import { ConfigError, type OpenAICompatProviderConfig, type ProviderConfig } from "../core/config";
import { CredentialMissingError, credentialMissingMessage, resolveCredentialValue, type VaultReader } from "../credential-ref";
import { loadEffectiveConfig, providerIdentityFor, updateGlobalProviderCredentialRef, updateProjectProviderCredentialRef, type EffectiveConfig } from "../providers/profiles";
import { isEnvName, isVaultCredentialRef } from "../secrets";
import { Vault, vaultPath } from "../vault";

export interface MissingActiveCredential {
  provider: string;
  model: string;
  credentialRef: string;
  /** Layer that owns the provider definition; it decides where a new ref is written. */
  source: "project" | "global";
  /** Actionable next step; names the ref and the provider, never the value (I-03). */
  message: string;
}

export interface ActiveCredentialProbe {
  configPath: string;
  env?: NodeJS.ProcessEnv;
  /** Absent project layer and `--provider` follow the TUI boot; the vault defaults to the environment. */
  allowMissing?: boolean;
  provider?: string;
  vault?: VaultReader;
}

/** Only openai-compat resolves a ref here; codex-oauth reads a credentials file. */
function keyed(config: ProviderConfig | undefined): config is OpenAICompatProviderConfig & { credentialRef: string } {
  return config?.kind === "openai-compat" && config.credentialRef !== undefined;
}

function providerOfModel(modelRef: string, providers: Record<string, ProviderConfig>): string | undefined {
  return Object.keys(providers).sort((a, b) => b.length - a.length).find((name) => modelRef.startsWith(`${name}/`));
}

/** Effective model whose credential does not resolve, or nothing to recover; never throws. */
export function probeActiveCredential(input: ActiveCredentialProbe): MissingActiveCredential | undefined {
  const env = input.env ?? process.env;
  const vault = input.vault ?? new Vault(vaultPath(env));
  let effective: EffectiveConfig;
  try {
    effective = loadEffectiveConfig(input.configPath, {
      env, allowMissing: input.allowMissing === true,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
    });
  } catch {
    return undefined; // config errors stay on the existing boot and health path
  }
  const model = effective.config.agent.model;
  const provider = providerOfModel(model, effective.config.providers);
  const config = provider === undefined ? undefined : effective.config.providers[provider];
  if (provider === undefined || !keyed(config)) return undefined;
  const credentialRef = config.credentialRef;
  try {
    const value = resolveCredentialValue(credentialRef, env, vault);
    if (value !== undefined && value.length > 0) return undefined;
  } catch (error) {
    if (!(error instanceof CredentialMissingError)) return undefined; // malformed ref: health owns it
  }
  const source = providerIdentityFor(effective, provider).providerSource;
  if (source === "env") return undefined; // the environment profile only exists with its key present
  return {
    provider, model, credentialRef, source: source === "project" ? "project" : "global",
    message: credentialMissingMessage(credentialRef, provider),
  };
}

export type CredentialRecovery =
  | { kind: "not-needed" }
  | { kind: "recovered"; provider: string; model: string }
  | { kind: "unresolved"; message: string }
  | { kind: "declined"; message: string };

export interface CredentialRecoveryOptions {
  probe: () => MissingActiveCredential | undefined;
  /** Existing recovery surface; true when a new reference was written to a layer. */
  recover: (missing: MissingActiveCredential) => Promise<boolean>;
  notify: (message: string) => void;
}

/**
 * Offers recovery once and re-probes. A cancel is `declined`; a ref written but
 * still unresolved says so instead of claiming a cancel, and neither falls back
 * to another identity (I-08).
 */
export async function recoverActiveCredential(opts: CredentialRecoveryOptions): Promise<CredentialRecovery> {
  const missing = opts.probe();
  if (missing === undefined) return { kind: "not-needed" };
  opts.notify(missing.message);
  if (!(await opts.recover(missing))) return { kind: "declined", message: missing.message };
  const left = opts.probe();
  if (left !== undefined) return { kind: "unresolved", message: `referência "${left.credentialRef}" gravada, mas o valor ainda não resolve · ${left.message}` };
  return { kind: "recovered", provider: missing.provider, model: missing.model };
}

/**
 * Writes only `credentialRef` in the layer that declares the provider (#616).
 * A vault ref or an env name is the only accepted shape, so a pasted value
 * never reaches a file (I-03).
 */
export function writeRecoveredCredentialRef(input: {
  missing: MissingActiveCredential; ref: string; configPath: string; env: NodeJS.ProcessEnv;
}): void {
  if (!isVaultCredentialRef(input.ref) && !isEnvName(input.ref)) {
    throw new ConfigError('credentialRef inválido: use "vault:<credentialId>" ou um nome de variável de ambiente', "config_invalid_schema");
  }
  if (input.missing.source === "project") return updateProjectProviderCredentialRef(input.configPath, input.env, input.missing.provider, input.ref);
  updateGlobalProviderCredentialRef(input.env, input.missing.provider, input.ref);
}
