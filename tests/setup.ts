/** Isola a suíte do ~/.astro real do desenvolvedor (ASTRO_HOME temporário). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowsAcl } from "../src/attachments/acl";

/**
 * ACL owner-only fake para injetar `hardenPrivate` em testes e não spawnar
 * PowerShell real (o cold start passa de 15 s no runner windows do CI).
 */
export const FAKE_PRIVATE_ACL: WindowsAcl = {
  userSid: "S-1-5-21-0-0-0-1000",
  sddl: "O:S-1-5-21-0-0-0-1000G:S-1-5-21-0-0-0-513D:PAI(A;OICI;FA;;;S-1-5-21-0-0-0-1000)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
};

/** Diretório ASTRO_HOME temporário criado para a suíte de testes. */
export const TEST_ASTRO_HOME = mkdtempSync(join(tmpdir(), "astro-tests-home-"));

/**
 * Conjuntos de provider (#472): a suíte não herda provider do host, senão um
 * `OPENAI_*`/`NVIDIA_*` exportado na máquina mudaria a resolução do ambiente.
 */
const HOST_PROVIDER_VARS = [
  "ASTRO_PROVIDER", "ASTRO_MODEL", "ASTRO_BASE_URL",
  "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL",
  "NVIDIA_API_KEY", "NVIDIA_MODEL", "NVIDIA_BASE_URL",
  "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_BASE_URL",
] as const;

for (const name of HOST_PROVIDER_VARS) delete process.env[name];

/** Variáveis de ambiente obrigatórias para que os testes usem o home temporário e URLs privadas. */
export const TEST_BASE_ENV: Readonly<Record<string, string>> = {
  ASTRO_HOME: TEST_ASTRO_HOME,
  ASTRO_ALLOW_PRIVATE_URLS: "1",
  ASTRO_ALLOW_INSECURE_BASE_URL: "1",
} as const;

process.env.ASTRO_HOME = TEST_ASTRO_HOME;
process.env.ASTRO_ALLOW_PRIVATE_URLS = "1";
process.env.ASTRO_ALLOW_INSECURE_BASE_URL = "1";

/**
 * Mescla variáveis de ambiente do teste com a base obrigatória (ASTRO_HOME + ASTRO_ALLOW_PRIVATE_URLS).
 * Use em vez de passar `env: { KEY: "k" }` diretamente para `runTask`, `AgentSession`, etc.
 *
 * @param extra Variáveis adicionais do caso de teste (ex.: credenciais de mock)
 * @returns Objeto env completo pronto para uso nos testes
 */
export function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...TEST_BASE_ENV, ...extra };
}
