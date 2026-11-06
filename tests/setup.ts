/** Isola a suíte do ~/.astro real do desenvolvedor (ASTRO_HOME temporário). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Diretório ASTRO_HOME temporário criado para a suíte de testes. */
export const TEST_ASTRO_HOME = mkdtempSync(join(tmpdir(), "astro-tests-home-"));

/** Variáveis de ambiente obrigatórias para que os testes usem o home temporário e URLs privadas. */
export const TEST_BASE_ENV: Readonly<Record<string, string>> = {
  ASTRO_HOME: TEST_ASTRO_HOME,
  ASTRO_ALLOW_PRIVATE_URLS: "1",
} as const;

process.env.ASTRO_HOME = TEST_ASTRO_HOME;
process.env.ASTRO_ALLOW_PRIVATE_URLS = "1";

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