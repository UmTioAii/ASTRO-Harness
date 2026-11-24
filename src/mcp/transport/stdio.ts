import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { sanitizedEnv } from "../../tools/run-command";
import { MCPError } from "../types";

/**
 * MCP stdio transport (#56): newline-delimited JSON-RPC 2.0 on a process's
 * stdin/stdout. The server is arbitrary code — the environment is the same
 * sanitized one as run_command (I-03): no host keys, only the config's explicit `env`.
 */
export interface StdioTransportOptions { command: string; args: string[]; env?: Record<string, string>; timeoutMs: number; secretEnvNames?: readonly string[] }

/**
 * Child surface the transport touches: `spawn` satisfies it, and a test attaches a
 * scripted child so a broken pipe is an explicit event instead of an OS race (#643).
 */
export interface StdioChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  kill(): unknown;
  on: EventEmitter["on"];
  off: EventEmitter["off"];
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class StdioTransport {
  #proc: StdioChild | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  #closed = false;
  #buffer = "";

  private constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  static connect(opts: StdioTransportOptions): StdioTransport {
    const child = spawn(opts.command, opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...sanitizedEnv(process.env, opts.secretEnvNames ?? []), ...(opts.env ?? {}) },
      windowsHide: true,
    });
    return StdioTransport.fromChild(child, opts.timeoutMs);
  }

  /** Wraps an already-spawned child: `connect` spawns, tests attach a scripted one (#643). */
  static fromChild(child: StdioChild, timeoutMs: number): StdioTransport {
    const transport = new StdioTransport(timeoutMs);
    transport.#proc = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => transport.#onData(chunk));
    child.on("error", (error: Error) => transport.#failAll(error));
    child.on("exit", () => transport.#failAll(new MCPError("processo do servidor MCP encerrou")));
    return transport;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue; // an invalid line does not take the transport down
      }
      if (typeof message.id !== "number") continue; // server notification: ignored for now
      const pending = this.#pending.get(message.id);
      if (pending === undefined) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new MCPError(message.error.message ?? "erro do servidor MCP"));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const proc = this.#proc;
    if (this.#closed || proc === undefined) {
      return Promise.reject(new MCPError("transport MCP fechado"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new MCPError(`timeout de ${this.#timeoutMs}ms no MCP ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error !== undefined && error !== null) {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(new MCPError(`falha ao escrever no MCP: ${String(error)}`));
        }
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.#closed && this.#proc !== undefined) this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** True after the process exited or the transport was closed. */
  get closed(): boolean {
    return this.#closed;
  }

  close(): void { this.#failAll(new MCPError("transport MCP fechado")); this.#proc?.stdin.end(); this.#proc?.kill(); }
}
