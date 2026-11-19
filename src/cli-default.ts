/**
 * Comando padrão do CLI: sem argumentos em terminal interativo abre a TUI;
 * em pipe imprime o help (a TUI exige TTY).
 */
export function defaultArgs(argv: readonly string[], interactive: boolean): string[] {
  if (argv.length > 0) return [...argv];
  // Sem argumentos e com TTY o CLI decide a TUI; em pipe imprime o help.
  return interactive ? [] : ["--help"];
}

/** Rota decidida só pelo argv, antes de qualquer efeito (#543). */
export type ArgvRoute =
  | { kind: "tui"; options: string[] }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "command"; command: string; rest: string[] };

/**
 * Decide a rota a partir do argv cru (#543): argv vazio e argv só de flags
 * abrem a TUI; `help` e `--version` existem como comando; o resto é comando.
 * A decisão é pura para poder ser testada sem TTY — o `main` só executa o que
 * aqui foi decidido.
 */
export function routeArgv(argv: readonly string[]): ArgvRoute {
  if (argv.length === 0) return { kind: "tui", options: [] };
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [command, ...rest] = argv as [string, ...string[]];
  if (command === "help") return { kind: "help" };
  if (command === "--version" || command === "-v" || command === "version") return { kind: "version" };
  // Só flags (`astro --config x`): é a TUI com opções, não um comando.
  if (command.startsWith("-")) return { kind: "tui", options: [...argv] };
  return { kind: "command", command, rest };
}

/** TUI só quando stdin e stdout são TTY; meio-TTY (pipe) vira help. */
export function isInteractive(
  stdinTTY: boolean | undefined,
  stdoutTTY: boolean | undefined,
): boolean {
  return stdinTTY === true && stdoutTTY === true;
}
