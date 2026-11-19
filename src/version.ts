/** Versão publicada, lida do `package.json` do pacote (src/ e dist/ ficam na raiz). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Lê `version` do package.json ao lado do módulo. Em `src/cli.ts` é a raiz do
 * repo; em `dist/cli.js` é a raiz do pacote npm — os dois têm package.json.
 * Ausente ou inválido devolve `undefined` em vez de derrubar o CLI.
 */
export function packageVersion(): string | undefined {
  try {
    const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
    const raw = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

/** Linha de `astro --version`. */
export function versionLine(): string {
  const version = packageVersion();
  return version === undefined ? "astro (versão desconhecida)" : `astro ${version}`;
}
