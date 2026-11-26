/** I/O do REPL via readline (fila de linhas; SIGINT aborta o turno e encerra). */
import { createInterface } from "node:readline";
import type { ReplIO } from "./repl";
import { maskSecretReadline } from "./readline-secret";

export interface NodeReplIO extends ReplIO {
  close(): void;
  signal: AbortSignal;
  readCancelable(prompt: string, signal?: AbortSignal): Promise<string | null>;
}

/** Opções do readline: histórico (setas) só faz sentido em terminal. */
export function nodeReplOptions(terminal: boolean): {
  terminal: boolean;
  historySize: number;
  removeHistoryDuplicates: boolean;
} {
  return {
    terminal,
    historySize: terminal ? 200 : 0,
    removeHistoryDuplicates: true,
  };
}

export function nodeReplIO(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): NodeReplIO {
  const terminal = (input as NodeJS.ReadStream).isTTY === true;
  const rl = createInterface({
    ...nodeReplOptions(terminal),
    input,
    output,
  });
  const controller = new AbortController();
  const pending: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else pending.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  rl.on("SIGINT", () => {
    controller.abort(new Error("cancelado"));
    rl.close();
  });
  const write = (text: string): void => {
    output.write(text);
  };
  return {
    signal: controller.signal,
    read: async (prompt, opts) => {
      write(prompt);
      const unmask = opts?.secret === true ? maskSecretReadline(rl, output) : undefined;
      const queued = pending.shift();
      if (queued !== undefined) { unmask?.(queued); return queued; }
      if (closed) { unmask?.(""); return null; }
      const line = await new Promise<string | null>((resolve) => waiters.push(resolve));
      unmask?.(line ?? "");
      return line;
    },
    /** Ignora linhas já enfileiradas: decisor no meio do turno espera resposta nova. */
    readFresh: async (prompt) => {
      write(prompt);
      if (closed) return null;
      return await new Promise<string | null>((resolve) => waiters.push(resolve));
    },
    /** #526: sair da fila no abort — sem isso a próxima linha cai num waiter morto. */
    readCancelable: async (prompt, signal) => {
      // Uma espera que já expirou não imprime prompt nem entra na fila.
      if (signal?.aborted === true) return null;
      if (closed) return null;
      write(prompt);
      return await new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (line: string | null): void => {
          if (settled) return;
          settled = true;
          const index = waiters.indexOf(finish);
          if (index >= 0) waiters.splice(index, 1);
          signal?.removeEventListener("abort", onAbort);
          resolve(line);
        };
        const onAbort = (): void => finish(null);
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(finish);
      });
    },
    write: (text) => write(`${text}\n`),
    close: () => {
      if (!closed) rl.close();
      closed = true;
    },
  };
}
