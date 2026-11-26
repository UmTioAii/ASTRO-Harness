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

test("secret input is masked and cannot be recalled from history (#629)", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = new PassThrough();
  let echoed = "";
  output.on("data", (chunk) => { echoed += String(chunk); });
  const io = nodeReplIO(input, output);
  const secret = "sk-tty-history-sentinel";
  try {
    const reading = io.read("key: ", { secret: true });
    input.write(`${secret}\r`);
    await expect(reading).resolves.toBe(secret);
    const recall = io.read("next: ");
    input.write("\u001b[A\r");
    await expect(recall).resolves.not.toBe(secret);
    expect(echoed).not.toContain(secret);
  } finally {
    io.close();
  }
});
