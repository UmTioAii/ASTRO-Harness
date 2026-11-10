/** Privacidade da raiz de artefato (ADR-0026): 0700 no POSIX e DACL sem grupos abertos no Windows. */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

/** SIDs (alias e completos) que significam "outro usuário local" num DACL. */
const OPEN_PRINCIPALS = new Set([
  "WD", "S-1-1-0",
  "BU", "S-1-5-32-545",
  "AU", "S-1-5-11",
  "IU", "S-1-5-4",
]);

/** `true` só se nenhum ACE de allow libera um grupo aberto; entrada inválida falha fechado. */
export function windowsAclIsPrivate(sddl: string): boolean {
  const aces = [...sddl.matchAll(/\(([^)]*)\)/g)];
  if (aces.length === 0) return false;
  for (const [, body] of aces) {
    const fields = body.split(";");
    if (fields.length < 6) return false;
    const type = fields[0]!.trim().toUpperCase();
    const sid = fields[5]!.trim().toUpperCase();
    if (sid === "") return false;
    if (type.endsWith("D")) continue; // deny não concede acesso
    if (!type.endsWith("A")) return false; // tipo desconhecido: falha fechado
    if (OPEN_PRINCIPALS.has(sid)) return false;
  }
  return true;
}

/**
 * Um `PSModulePath` com módulos do PowerShell 7 junto do 5.1 quebra o type data de
 * `ObjectSecurity` (`AuditToString` duplicado) e derruba `Get-Acl`; sem a variável o
 * `powershell.exe` resolve o módulo `Security` pelo caminho default do sistema.
 */
function aclEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ASTRO_ACL_PATH: path };
  delete env.PSModulePath;
  return env;
}

/** Checagem default: modo POSIX ou DACL do Windows; qualquer falha fecha. */
export function defaultCheckPrivate(path: string): boolean {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    // Raiz ainda não criada: o construtor cria com 0700 e revalida no Windows.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (process.platform !== "win32") return (mode & 0o077) === 0;
  try {
    const sddl = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:ASTRO_ACL_PATH).Sddl"],
      {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: aclEnv(path),
      },
    );
    return windowsAclIsPrivate(sddl);
  } catch {
    return false;
  }
}
