/**
 * Shell do host (#474, #599): vocabulário fechado, detecção dos shells presentes
 * e argv para executar o comando do modelo. É o caminho default do `run_command`
 * desde #599; o caminho Docker do ADR-0027 não usa este módulo.
 */

/** Shells que o `/shell` lista; fora daqui não é aceito na config (#474). */
export const HOST_SHELLS = ["pwsh", "powershell", "cmd", "bash", "zsh", "sh"] as const;

export type HostShell = (typeof HOST_SHELLS)[number];

export function isHostShell(value: unknown): value is HostShell {
  return typeof value === "string" && (HOST_SHELLS as readonly string[]).includes(value);
}

/** Ordem de preferência por plataforma quando `shell.default` não está definido. */
const WINDOWS_ORDER: readonly HostShell[] = ["pwsh", "powershell", "cmd"];
const POSIX_ORDER: readonly HostShell[] = ["bash", "zsh", "sh"];

/**
 * Shells presentes na máquina, na ordem canônica de `HOST_SHELLS`. `which` é
 * injetável para teste; o default é `Bun.which` (sem dependência nova).
 */
export function detectHostShells(
  which: (name: string) => string | null = (name) => Bun.which(name),
): HostShell[] {
  return HOST_SHELLS.filter((shell) => {
    try {
      return which(shell) !== null;
    } catch {
      return false; // fail-closed: falha ao procurar = ausente
    }
  });
}

export type HostShellSelection =
  | { kind: "shell"; shell: HostShell }
  | { kind: "error"; code: "shell_not_available" | "shell_none_available"; message: string };

/**
 * Escolhe o shell do host: `preferred` (config) só vale se estiver presente;
 * ausente na máquina = erro (nunca troca de shell em silêncio). Sem preferência,
 * usa a ordem da plataforma entre os presentes.
 */
export function selectHostShell(
  available: readonly HostShell[],
  preferred: string | undefined,
  platform: string = process.platform,
): HostShellSelection {
  const present = new Set(available);
  if (preferred !== undefined && preferred !== "") {
    if (isHostShell(preferred) && present.has(preferred)) return { kind: "shell", shell: preferred };
    return {
      kind: "error",
      code: "shell_not_available",
      message: `shell_not_available: shell.default "${preferred}" não está disponível nesta máquina`,
    };
  }
  const order = platform === "win32" ? WINDOWS_ORDER : POSIX_ORDER;
  const found = order.find((shell) => present.has(shell));
  return found === undefined
    ? { kind: "error", code: "shell_none_available", message: "shell_none_available: nenhum shell suportado encontrado no PATH" }
    : { kind: "shell", shell: found };
}

/** Argv do shell do host: o comando do modelo é UM argumento, nunca interpolado pelo harness. */
export function hostShellArgv(shell: HostShell, command: string): string[] {
  switch (shell) {
    case "pwsh":
    case "powershell":
      return [shell, "-NoProfile", "-NonInteractive", "-Command", command];
    case "cmd":
      return ["cmd.exe", "/d", "/s", "/c", command];
    case "bash":
    case "zsh":
    case "sh":
      return [shell, "-c", command];
  }
}
