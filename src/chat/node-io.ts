/** I/O do REPL via readline (fila de linhas; SIGINT aborta o turno e encerra). */
import { createInterface } from "node:readline";
import type { ReplIO } from "./repl";
import { protectReadline } from "./readline-secret";

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
  const protect = protectReadline(rl, output);
  const controller = new AbortController();
  const pending: Array<{ text: string; secret: boolean }> = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false, readingSecret = false;
  rl.on("line", (text) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(text);
    else pending.push({ text, secret: readingSecret });
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
      const secret = opts?.secret === true; readingSecret = secret;
      const finish = protect(secret), queued = pending.shift();
      if (queued !== undefined) {
        if (secret) for (const line of pending) if (line.text === queued.text) line.secret = true;
        finish(queued.text, secret || queued.secret); return queued.text;
      }
      if (closed) { finish("", secret); return null; }
      const line = await new Promise<string | null>((resolve) => waiters.push(resolve));
      finish(line ?? "", secret); return line;
    },
    /** Ignora linhas já enfileiradas: decisor no meio do turno espera resposta nova. */
    readFresh: async (prompt) => {
      readingSecret = false; const finish = protect(false);
      write(prompt);
      if (closed) { finish(""); return null; }
      const line = await new Promise<string | null>((resolve) => waiters.push(resolve));
      finish(line ?? "");
      return line;
    },
    /** #526: sair da fila no abort — sem isso a próxima linha cai num waiter morto. */
    readCancelable: async (prompt, signal) => {
      // Uma espera que já expirou não imprime prompt nem entra na fila.
      readingSecret = false;
      if (signal?.aborted === true) return null;
      if (closed) return null;
      const done = protect(false);
      write(prompt);
      return await new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (line: string | null): void => {
          if (settled) return;
          settled = true;
          done(line ?? "");
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
