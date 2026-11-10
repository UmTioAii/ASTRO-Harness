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
      timeout: 60_000, // runner windows-latest: o cold start do PowerShell passa de 15 s
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
 * Script de endurecimento: monta uma DACL nova, protegida (sem herança) e com
 * controle total só para o usuário atual, SYSTEM e Administrators, e a instala
 * com `Set-Acl`. Uma DACL nova descarta ACEs herdadas *e* explícitas; `icacls
 * /inheritance:r` só remove as herdadas e deixaria uma ACE explícita da raiz.
 */
const HARDEN_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$path=$env:ASTRO_ACL_PATH",
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl=New-Object System.Security.AccessControl.DirectorySecurity",
  "$acl.SetAccessRuleProtection($true,$false)",
  "$acl.SetOwner($sid)",
  "foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')){",
  "  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($id)),[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)",
  "  $acl.AddAccessRule($rule)",
  "}",
  "Set-Acl -LiteralPath $path -AclObject $acl",
  "Write-Output $sid.Value",
  "Write-Output (Get-Acl -LiteralPath $path).Sddl",
].join("\n");

/**
 * Reescreve a DACL da raiz como owner-only numa única chamada ao PowerShell e
 * devolve o resultado lido do sistema (o store não precisa de um segundo spawn).
 * `powershell.exe` absoluto, cwd do sistema, env mínimo. Qualquer falha lança.
 */
export function hardenWindowsAcl(path: string): WindowsAcl {
  const root = windowsRoot();
  const exe = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(exe)) throw new Error("powershell.exe não encontrado");
  const output = execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", HARDEN_SCRIPT], {
    encoding: "utf8",
    timeout: 60_000, // runner windows-latest: o cold start do PowerShell passa de 15 s
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    cwd: join(root, "System32"),
    env: aclEnv(path),
    maxBuffer: 1 << 20,
  });
  const lines = output.split(/\r?\n/);
  const userSid = lines[0]?.trim() ?? "";
  if (!/^S-1-[0-9-]+$/.test(userSid)) throw new Error("SID do usuário atual inválido após o endurecimento");
  const sddl = lines.slice(1).join("").trim();
  if (sddl === "") throw new Error("SDDL vazio após o endurecimento");
  return { userSid, sddl };
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
