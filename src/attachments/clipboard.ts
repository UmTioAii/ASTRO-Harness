/**
 * Leitura do clipboard de texto (ADR-0026, #392): sem dependência nova, usa o
 * comando nativo de cada plataforma. Imagem do clipboard fica adiada pelo ADR.
 */
import { execFileSync } from "node:child_process";

export interface ClipboardCommand {
  command: string;
  args: string[];
}

/** Comando nativo por plataforma; `undefined` = plataforma sem suporte. */
export function clipboardCommand(platform: NodeJS.Platform = process.platform): ClipboardCommand | undefined {
  if (platform === "win32") {
    return { command: "powershell", args: ["-NoProfile", "-Command", "Get-Clipboard"] };
  }
  if (platform === "darwin") return { command: "pbpaste", args: [] };
  if (platform === "linux") return { command: "wl-paste", args: ["--no-newline"] };
  return undefined;
}

/** Executa o comando e devolve o texto; vazio/indisponível vira erro tipado. */
export function readClipboardText(
  platform: NodeJS.Platform = process.platform,
  run: (command: ClipboardCommand) => string | undefined = (command) =>
    execFileSync(command.command, command.args, { encoding: "utf8", timeout: 5_000 }),
): string {
  const command = clipboardCommand(platform);
  if (command === undefined) {
    throw new Error(`clipboard indisponível nesta plataforma (${platform})`);
  }
  let output: string | undefined;
  try {
    output = run(command);
  } catch {
    throw new Error("clipboard indisponível: não foi possível ler o texto");
  }
  if (output === undefined || output.trim() === "") {
    throw new Error("clipboard vazio: copie um texto antes de /paste");
  }
  return output;
}
