/**
 * Minimal MCP stdio client used by the QA suite.
 *
 * Speaks the wire protocol directly rather than using the SDK client, so the
 * tests exercise the same path a real editor integration would and would catch
 * a protocol-level regression the SDK might paper over.
 */

import { spawn } from "node:child_process";

export class McpClient {
  constructor(command, args, env = {}) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.buffer = "";

    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  #onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = this.pending.get(message.id);
      if (entry) {
        this.pending.delete(message.id);
        entry(message);
      }
    }
  }

  request(method, params = {}, timeoutMs = 300_000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.child.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "godot-assistant-qa", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  async listTools() {
    return (await this.request("tools/list")).tools;
  }

  async call(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  /** Concatenated text content of a tool result. */
  static textOf(result) {
    return (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  static imageOf(result) {
    return (result.content ?? []).find((c) => c.type === "image");
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}
