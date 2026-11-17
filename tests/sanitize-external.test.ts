import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../src/sanitize-external";
import { readFileTool } from "../src/tools/read-file";

// Montados em runtime para não expor literais no diff (gate G6)
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLWRlLXRlc3Rl"].join(".");
const PEM_HEADER = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const PEM_FOOTER = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
const PEM_BODY = "MIIEowIBAAKCAQEA7teste";
const PEM = [PEM_HEADER, PEM_BODY, PEM_FOOTER].join("\n");

test("redactSecrets cobre JWT e bloco PEM de chave privada", () => {
  const redacted = redactSecrets(`token=${JWT}\n${PEM}\n`);
  expect(redacted).not.toContain(JWT);
  expect(redacted).not.toContain(PEM_BODY);
  expect(redacted).toContain("[REDACTED]");
});

test("redactSecrets redige hex longo só com contexto de credencial", () => {
  const hex = "0123456789abcdef0123456789abcdef01234567";
  expect(redactSecrets(`api_key: ${hex}`)).not.toContain(hex);
  // sha de commit em texto corrido não é segredo e continua legível
  expect(redactSecrets(`commit ${hex}`)).toContain(hex);
});

test("redactSecrets redige hex de 64+ sem contexto e preserva SHA-1/MD5 comuns", () => {
  const hex64 = "a1b2c3d4".repeat(8); // 64 hex: segredo provável (chave/hash de token)
  const hex40 = "0123456789abcdef0123456789abcdef01234567"; // git SHA-1
  const hex32 = "0123456789abcdef0123456789abcdef"; // MD5/checksum: residual
  expect(redactSecrets(`chave ${hex64}`)).not.toContain(hex64);
  expect(redactSecrets(`chave ${hex64}`)).toContain("[REDACTED]");
  // 40 hex só com rótulo de credencial; saída normal de git continua legível
  expect(redactSecrets(`KEY=${hex40}`)).not.toContain(hex40);
  expect(redactSecrets(`token: ${hex40}`)).not.toContain(hex40);
  expect(redactSecrets(`commit ${hex40}`)).toContain(hex40);
  expect(redactSecrets(`checksum ${hex32}`)).toContain(hex32);
});

test("read_file sanitiza conteúdo externo antes de devolver à sessão", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-sanitize-"));
  writeFileSync(join(dir, "env.txt"), `TOKEN ${JWT}\n${PEM}\n`, "utf8");
  const result = await readFileTool.execute({ path: "env.txt" }, { cwd: dir, run: "r1", agent: "a" });

  expect(result.isError).toBeUndefined();
  expect(result.output).not.toContain(JWT);
  expect(result.output).not.toContain(PEM_BODY);
});
