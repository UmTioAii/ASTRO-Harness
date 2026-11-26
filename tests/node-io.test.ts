import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { nodeReplIO } from "../src/chat/node-io";
import { ttySetupIO } from "../src/chat/setup";

const terminalAdapters = [
  ["REPL", (input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => {
    const io = nodeReplIO(input, output);
    return { io, close: () => io.close() };
  }],
  ["setup", ttySetupIO],
] as const;

describe("REPL: leitura de aprovação cancelável (#526)", () => {
  test("abortar remove o waiter e a próxima linha vai para a leitura seguinte", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = nodeReplIO(input, output);
    const controller = new AbortController();

    const pending = io.readCancelable("aprovar? ", controller.signal);
    controller.abort();

    await expect(pending).resolves.toBeNull();

    // Sem a remoção do waiter, esta linha cairia num waiter morto e `read` ficaria pendurado.
    input.write("echo oi\n");
    await expect(io.read("> ")).resolves.toBe("echo oi");

    io.close();
  });

  test("sinal já abortado não abre leitura", async () => {
    const input = new PassThrough();
    const io = nodeReplIO(input, new PassThrough());
    const controller = new AbortController();
    controller.abort();

    await expect(io.readCancelable("aprovar? ", controller.signal)).resolves.toBeNull();

    io.close();
  });
});

for (const [name, open] of terminalAdapters) {
  test(`${name} masks direct and type-ahead secrets and excludes them from history (#629)`, async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true }), output = new PassThrough();
    let echoed = "";
    output.on("data", (chunk) => { echoed += String(chunk); });
    const { io, close } = open(input, output);
    const direct = "sk-tty-direct-sentinel", pasted = "sk-tty-typeahead-sentinel";
    const expectNoRecall = async (secret: string) => {
      const recall = io.read("next: "); input.write("\u001b[A\r");
      await expect(recall).resolves.not.toBe(secret);
      expect(echoed).not.toContain(secret);
    };
    try {
      const reading = io.read("key: ", { secret: true }); input.write(`${direct}\r`);
      await expect(reading).resolves.toBe(direct);
      await expectNoRecall(direct);
      const first = io.read("name: "); input.write(`Local\r${pasted}\r`);
      await expect(first).resolves.toBe("Local");
      expect(echoed).not.toContain(pasted);
      input.write("\u001b[A");
      await expect(io.read("key: ", { secret: true })).resolves.toBe(pasted);
      const editing = io.read("next: "); input.write("\u007f");
      await new Promise((resolve) => setImmediate(resolve));
      expect(echoed).not.toContain(pasted.slice(0, -1));
      input.write("\u0015\r"); await editing;
      await expectNoRecall(pasted);
    } finally {
      close();
    }
  });
}
