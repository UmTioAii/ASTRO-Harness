import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { nodeReplIO } from "../src/chat/node-io";

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
