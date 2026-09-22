import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export class DeliveryError extends Error {
  constructor(message, outcome = "unknown") {
    super(message);
    this.outcome = outcome;
  }
}
export function lines(stream, receive, fail, maxBytes = 2 ** 20) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > maxBytes) {
      fail(new Error("Protocol frame too large"));
      return;
    }
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        receive(JSON.parse(line));
      } catch (e) {
        fail(e);
      }
    }
  });
}
export class Rpc extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
    this.serial = 0;
    this.closed = false;
  }
  receive(message) {
    if (message.method) {
      if (message.id != null) {
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          ...(message.method === "ping"
            ? { result: {} }
            : {
                error: {
                  code: -32601,
                  message:
                    "OpenSwarm is a messaging client; it cannot approve provider actions",
                },
              }),
        });
      } else this.emit("notification", message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    message.error
      ? pending.reject(new DeliveryError(message.error.message, "rejected"))
      : pending.resolve(message.result);
  }
  fail(error) {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  request(method, params = {}, timeout = 15000) {
    if (this.closed)
      return Promise.reject(
        new DeliveryError(
          "Provider disconnected before submission",
          "unavailable",
        ),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeliveryError(`${method} timed out; result is unknown`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async initialize(kind = "mcp") {
    await this.request(
      "initialize",
      kind === "mcp"
        ? {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "openswarm", version: "0.1.0" },
          }
        : {
            clientInfo: { name: "openswarm", version: "0.1.0" },
            capabilities: { experimentalApi: true },
          },
      10000,
    );
    this.write({
      jsonrpc: "2.0",
      method: kind === "mcp" ? "notifications/initialized" : "initialized",
    });
    return this;
  }
  async tool(name, args, meta) {
    const result = await this.request(
      "tools/call",
      { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
      45000,
    );
    const output =
      result.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") || "";
    if (result.isError)
      throw new DeliveryError(
        output || "Provider rejected request",
        "rejected",
      );
    try {
      return JSON.parse(output);
    } catch {
      return { text: output };
    }
  }
}
export class StdioRpc extends Rpc {
  constructor(command, args, options = {}) {
    super();
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });
    this.child.stderr.resume(); // Never mix diagnostics with protocol or retain private provider output.
    this.child.on("error", (e) =>
      this.fail(new DeliveryError(e.message, "unavailable")),
    );
    this.child.on("exit", () =>
      this.fail(new DeliveryError("Provider helper disconnected")),
    );
    this.child.stdin.on("error", (e) =>
      this.fail(new DeliveryError(e.message)),
    );
    lines(
      this.child.stdout,
      (m) => this.receive(m),
      (e) => {
        this.fail(e);
        this.child.kill();
      },
    );
  }
  write(message) {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  close() {
    this.fail(new DeliveryError("Provider helper closed"));
    this.child.stdin.end();
    this.child.kill();
  }
}
export class WebSocketRpc extends Rpc {
  async connect(url) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      try {
        if (event.data.length > 2 ** 20)
          throw new Error("Provider frame too large");
        this.receive(JSON.parse(event.data));
      } catch (e) {
        this.fail(e);
        this.socket.close();
      }
    });
    this.socket.addEventListener("close", () =>
      this.fail(new DeliveryError("Provider disconnected")),
    );
    this.socket.addEventListener("error", () =>
      this.fail(
        new DeliveryError("Cannot connect to Codex app server", "unavailable"),
      ),
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.close();
        reject(new Error("Codex connection timed out"));
      }, 3000);
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Codex app server unavailable"));
        },
        { once: true },
      );
    });
    return this.initialize("codex");
  }
  write(message) {
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new DeliveryError("Codex disconnected", "unavailable");
    this.socket.send(JSON.stringify(message));
  }
  close() {
    this.fail(new DeliveryError("Codex connection closed"));
    this.socket?.close();
  }
}
