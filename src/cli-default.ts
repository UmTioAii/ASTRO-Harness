/**
 * Comando padrão do CLI: sem argumentos em terminal interativo abre a TUI;
 * em pipe imprime o help (a TUI exige TTY).
 */
export function defaultArgs(argv: readonly string[], interactive: boolean): string[] {
  if (argv.length > 0) return [...argv];
  // Sem argumentos e com TTY o CLI decide a TUI; em pipe imprime o help.
  return interactive ? [] : ["--help"];
}

/** TUI só quando stdin e stdout são TTY; meio-TTY (pipe) vira help. */
export function isInteractive(
  stdinTTY: boolean | undefined,
  stdoutTTY: boolean | undefined,
): boolean {
  return stdinTTY === true && stdoutTTY === true;
}
