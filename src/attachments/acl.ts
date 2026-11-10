/** Privacidade da raiz de artefato (ADR-0026): 0700 no POSIX e DACL owner-only no Windows. */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Identidade da raiz: SID do usuário atual e DACL lida do sistema. */
export interface WindowsAcl {
  userSid: string;
  sddl: string;
}

/** Trustees aceitos: o dono, o SYSTEM e o grupo Administrators (alias e SID completo). */
const SYSTEM_TRUSTEES = new Set(["SY", "S-1-5-18"]);
const ADMIN_TRUSTEES = new Set(["BA", "S-1-5-32-544"]);
const PATHEXT_VALUE = ".COM;.EXE;.BAT;.CMD";

function windowsRoot(): string {
  return process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
}

/**
 * Ambiente mínimo do filho. Também exclui `PSModulePath`: um caminho de módulos do
 * PowerShell 7 junto do 5.1 quebra o type data de `ObjectSecurity` (`AuditToString`
 * duplicado) e derruba `Get-Acl`; sem a variável o módulo `Security` vem do sistema.
 */
function aclEnv(path: string): NodeJS.ProcessEnv {
  const root = windowsRoot();
  return {
    SystemRoot: root,
    windir: root,
    PATH: `${join(root, "System32")};${root}`,
    PATHEXT: PATHEXT_VALUE,
    ASTRO_ACL_PATH: path,
  };
}

function isAllowedTrustee(trustee: string, userSid: string): boolean {
  const sid = trustee.trim().toUpperCase();
  if (sid === "") return false;
  return sid === userSid.trim().toUpperCase() || SYSTEM_TRUSTEES.has(sid) || ADMIN_TRUSTEES.has(sid);
}

/**
 * `true` só para DACL owner-only: dono em {usuário atual, SYSTEM, Administrators},
 * só ACEs de allow (6 campos) com trustee no mesmo conjunto e ao menos um allow.
 * Qualquer tipo, trustee, dono ou formato fora disso falha fechado.
 */
export function windowsAclIsPrivate(sddl: string, userSid: string): boolean {
  const owner = /^O:([^:]+)G:/.exec(sddl)?.[1]?.trim();
  if (owner === undefined || !isAllowedTrustee(owner, userSid)) return false;
  let allowed = 0;
  for (const [, body] of sddl.matchAll(/\(([^)]*)\)/g)) {
    const fields = body.split(";");
    if (fields.length !== 6) return false;
    const type = fields[0]!.trim().toUpperCase();
    if (type === "D" || type === "OD") continue; // deny não concede acesso
    if (type !== "A" && type !== "OA") return false; // tipo desconhecido: falha fechado
    if (!isAllowedTrustee(fields[5]!, userSid)) return false;
    allowed += 1;
  }
  return allowed > 0;
}

/**
 * Lê o SID atual e a DACL via `powershell.exe` absoluto, cwd do sistema e env mínimo.
 * Nunca resolve `powershell` pelo PATH/cwd; qualquer falha vira `undefined`.
 */
export function inspectWindowsAcl(path: string): WindowsAcl | undefined {
  const root = windowsRoot();
  const exe = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(exe)) return undefined;
  const script =
    "$ErrorActionPreference='Stop'; $id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=(Get-Acl -LiteralPath $env:ASTRO_ACL_PATH).Sddl; Write-Output $id; Write-Output $acl";
  try {
    const output = execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      cwd: join(root, "System32"),
      env: aclEnv(path),
      maxBuffer: 1 << 20,
    });
    const lines = output.split(/\r?\n/);
    const userSid = lines[0]?.trim() ?? "";
    if (!/^S-1-[0-9-]+$/.test(userSid)) return undefined;
    const sddl = lines.slice(1).join("").trim();
    if (sddl === "") return undefined;
    return { userSid, sddl };
  } catch {
    return undefined;
  }
}

/**
 * Reescreve a DACL da raiz como owner-only: sem herança, só usuário atual, SYSTEM e
 * Administrators com controle total. `icacls.exe` absoluto, cwd do sistema, env mínimo.
 */
export function hardenWindowsAcl(path: string, userSid: string): void {
  const root = windowsRoot();
  const exe = join(root, "System32", "icacls.exe");
  if (!existsSync(exe)) throw new Error("icacls.exe não encontrado");
  execFileSync(
    exe,
    [
      path,
      "/inheritance:r",
      "/grant:r", `*${userSid}:(OI)(CI)F`,
      "/grant:r", "*S-1-5-18:(OI)(CI)F",
      "/grant:r", "*S-1-5-32-544:(OI)(CI)F",
    ],
    {
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
      cwd: join(root, "System32"),
      env: aclEnv(path),
    },
  );
}

/** Checagem default: modo POSIX ou DACL owner-only do Windows; qualquer falha fecha. */
export function defaultCheckPrivate(path: string): boolean {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    // Raiz ainda não criada: o construtor cria, endurece e revalida.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (process.platform !== "win32") return (mode & 0o077) === 0;
  const acl = inspectWindowsAcl(path);
  return acl !== undefined && windowsAclIsPrivate(acl.sddl, acl.userSid);
}
