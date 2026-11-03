/**
 * Handlers da chave digitada na tela de providers (#350/#352): guardam a
 * credencial ativa anterior para que o rollback restaure o estado do cofre.
 */
import { isVaultCredentialRef, VAULT_REF_PREFIX } from "../secrets";
import type { Vault } from "../vault";

export interface SecretHandlers {
  saveSecret(providerId: string, secret: string): string;
  discardSecret(ref: string): void;
}

export function createSecretHandlers(vault: Vault): SecretHandlers {
  const previous = new Map<string, string | undefined>();
  return {
    saveSecret(providerId, secret) {
      const active = vault.list().find((item) => item.providerId === providerId && item.active)?.id;
      previous.set(providerId, active);
      const created = vault.create({ providerId, label: "tui", secret });
      return `${VAULT_REF_PREFIX}${created.id}`;
    },
    discardSecret(ref) {
      if (!isVaultCredentialRef(ref)) return;
      const id = ref.slice(VAULT_REF_PREFIX.length);
      const entry = vault.read(id);
      try {
        vault.remove(id);
        if (entry !== undefined) {
          // Vault.create desativou as demais do provider; devolve a ativa anterior.
          const active = previous.get(entry.providerId);
          if (active !== undefined) vault.activate(active);
        }
      } catch {
        // preserva o erro original da gravação do perfil
      }
      if (entry !== undefined) previous.delete(entry.providerId);
    },
  };
}
