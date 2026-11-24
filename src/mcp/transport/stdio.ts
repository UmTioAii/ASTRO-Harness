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
  #closing = false;
  /** Reason for the first transport failure: calls after it receive the real cause (#643). */
  #failure: MCPError | undefined;
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
    // Error guards live as long as the transport does: a broken pipe fails the pending
    // calls instead of escaping as an uncaught exception (#643).
    child.stdout.on("data", transport.#onData);
    child.stdout.on("error", transport.#onError);
    child.stdin.on("error", transport.#onError);
    child.on("error", transport.#onError);
    child.on("exit", transport.#onExit);
    child.on("close", transport.#onClose);
    return transport;
  }

  #onData = (chunk: string): void => {
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
  };

  #onError = (error: Error): void => {
    this.#failAll(new MCPError(`MCP transport failed: ${error.message}`));
  };

  #onExit = (): void => {
    this.#failAll(new MCPError("processo do servidor MCP encerrou"));
  };

  #onClose = (): void => {
    // 'close' can arrive without 'exit'/'error' through the fromChild seam: fail the pending
    // calls before dropping the guards, so nothing waits for the timeout (#643).
    this.#failAll(new MCPError("processo do servidor MCP encerrou"));
    this.#detach();
  };

  /** Removes only the listeners this transport added; called when the child stdio closes. */
  #detach(): void {
    const child = this.#proc;
    if (child === undefined) return;
    child.stdout.off("data", this.#onData);
    child.stdout.off("error", this.#onError);
    child.stdin.off("error", this.#onError);
    child.off("error", this.#onError);
    child.off("exit", this.#onExit);
    child.off("close", this.#onClose);
  }

  /** Fails every pending call once; the first failure is the reason later calls see. */
  #failAll(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error instanceof MCPError ? error : new MCPError(error.message);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new MCPError(this.#failure.message));
    }
    this.#pending.clear();
  }

  #closedError(): MCPError {
    return new MCPError(this.#failure?.message ?? "transport MCP fechado");
  }

  /** Writes one JSON-RPC line; a write/pipe failure fails every pending call (#643). */
  #write(line: string): void {
    const stdin = this.#proc?.stdin;
    if (stdin === undefined || this.#closed) return;
    try {
      stdin.write(line, (error) => {
        if (error !== undefined && error !== null) this.#failAll(this.#writeError(error));
      });
    } catch (error) {
      this.#failAll(this.#writeError(error)); // destroyed stream: write throws
    }
  }

  #writeError(error: unknown): MCPError {
    return new MCPError(`MCP transport write failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed || this.#proc === undefined) return Promise.reject(this.#closedError());
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new MCPError(`timeout de ${this.#timeoutMs}ms no MCP ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.#write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** True after the process exited or the transport was closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Closes once: fails the pending calls, flushes and kills the child. Error guards stay
   * attached until the child stdio closes, because flushing a queued write can hit a pipe
   * with no reader and must fail the calls instead of escaping (#643).
   */
  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#failAll(new MCPError("transport MCP fechado"));
    const child = this.#proc;
    if (child === undefined) return;
    child.stdin.end();
    child.kill();
  }
}
