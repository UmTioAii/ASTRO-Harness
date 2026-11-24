/** Isolates the suite from the developer's real ~/.astro (temporary ASTRO_HOME). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowsAcl } from "../src/attachments/acl";

/**
 * Owner-only ACL fake injected into `hardenPrivate` so tests do not spawn a
 * real PowerShell (cold start over 15 s on the CI windows runner).
 */
export const FAKE_PRIVATE_ACL: WindowsAcl = {
  userSid: "S-1-5-21-0-0-0-1000",
  sddl: "O:S-1-5-21-0-0-0-1000G:S-1-5-21-0-0-0-513D:PAI(A;OICI;FA;;;S-1-5-21-0-0-0-1000)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
};

/** Temporary ASTRO_HOME directory created for the test suite. */
export const TEST_ASTRO_HOME = mkdtempSync(join(tmpdir(), "astro-tests-home-"));

/**
 * Provider sets (#472): the suite does not inherit a provider from the host,
 * otherwise an `OPENAI_*`/`NVIDIA_*` exported on the machine would change how
 * the environment resolves.
 */
const HOST_PROVIDER_VARS = [
  "ASTRO_PROVIDER", "ASTRO_MODEL", "ASTRO_BASE_URL",
  "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL",
  "NVIDIA_API_KEY", "NVIDIA_MODEL", "NVIDIA_BASE_URL",
  "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_BASE_URL",
] as const;

for (const name of HOST_PROVIDER_VARS) delete process.env[name];

/**
 * Host override that would change the config layer for the whole suite (#656).
 * The canary in tests/test-isolation.test.ts asserts it stays unset.
 */
delete process.env.ASTRO_NO_GLOBAL_CONFIG;

/** Environment variables the tests require to use the temporary home and private URLs. */
export const TEST_BASE_ENV: Readonly<Record<string, string>> = {
  ASTRO_HOME: TEST_ASTRO_HOME,
  ASTRO_ALLOW_PRIVATE_URLS: "1",
  ASTRO_ALLOW_INSECURE_BASE_URL: "1",
} as const;

process.env.ASTRO_HOME = TEST_ASTRO_HOME;
process.env.ASTRO_ALLOW_PRIVATE_URLS = "1";
process.env.ASTRO_ALLOW_INSECURE_BASE_URL = "1";

/**
 * Merges test environment variables with the mandatory base (ASTRO_HOME + ASTRO_ALLOW_PRIVATE_URLS).
 * Use it instead of passing `env: { KEY: "k" }` straight to `runTask`, `AgentSession`, etc.
 *
 * @param extra Additional case variables (e.g. mock credentials)
 * @returns Complete env object ready for the tests
 */
export function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...TEST_BASE_ENV, ...extra };
}
