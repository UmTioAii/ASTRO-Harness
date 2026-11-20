/**
 * Preload do `scripts/packed-smoke.ts` (#542): faz um pipe passar por terminal
 * interativo, para a TUI do pacote instalado renderizar sem TTY real.
 *
 * Só é carregado por `bun --preload` dentro do diretório temporário do smoke —
 * não entra no `dist/` nem no pacote publicado. `isTTY` é o único sinal que
 * Ink (`getRawModeStream`) e `runTui` consultam; `setRawMode` vira no-op porque
 * o pipe não tem termios.
 */
const stdin = process.stdin as unknown as Record<string, unknown>;

function patch(target: Record<string, unknown>, key: string, value: unknown): void {
  if (target[key] === value) return;
  Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: false });
}

patch(stdin, "isTTY", true);
if (typeof stdin.setRawMode !== "function") patch(stdin, "setRawMode", () => process.stdin);
if (typeof stdin.ref !== "function") patch(stdin, "ref", () => undefined);
if (typeof stdin.unref !== "function") patch(stdin, "unref", () => undefined);

const stdout = process.stdout as unknown as Record<string, unknown>;
patch(stdout, "isTTY", true);
patch(stdout, "columns", 100);
patch(stdout, "rows", 40);
