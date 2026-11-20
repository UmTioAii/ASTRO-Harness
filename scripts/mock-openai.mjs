/**
 * Endpoint OpenAI-compatible só para loopback (#542): resposta fixa, sem
 * chamada externa. Fixture do wizard manual de `docs/release.md` §5 — o smoke
 * automatizado usa o mock interno de `scripts/packed-smoke.ts`.
 *
 * Uso: node scripts/mock-openai.mjs [porta]   (default 8787)
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8787);
const reply = {
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
};

createServer((req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" })
      .end('{"data":[{"id":"mock-model","object":"model"}]}');
    return;
  }
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
}).listen(port, "127.0.0.1", () => console.log(`mock: http://127.0.0.1:${port}/v1`));
