import { existsSync, readdirSync, lstatSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import { StdioRpc, WebSocketRpc, DeliveryError } from "./rpc.mjs";
import { UUID } from "./config.mjs";

const exec = promisify(execFile);
export function claudeAddress(listing, agents, nativeId) {
  const target = agents.find((s) => s.sessionId === nativeId);
  if (!target || agents.filter((s) => s.name === target.name).length !== 1)
    throw new DeliveryError(
      "Claude recipient unavailable or ambiguous",
      "unavailable",
    );
  const rows = (listing || "")
    .split("\n")
    .filter((line) => line.trimStart().startsWith(target.name + " ["));
  if (rows.length !== 1)
    throw new DeliveryError(
      "Claude recipient renamed, unavailable, or ambiguous",
      "unavailable",
    );
  return rows[0]
    .trim()
    .split(/\s+·\s+/)[0]
    .trim();
}
export function executable(
  provider,
  env = process.env,
  platform = process.platform,
) {
  const override = env[`OPENSWARM_${provider.toUpperCase()}`];
  if (override) return override;
  if (platform !== "win32") return provider;
  const dirs = [
    path.join(homedir(), ".local", "bin"),
    ...(env.PATH || "").split(path.delimiter),
  ];
  for (const dir of dirs)
    if (dir && existsSync(path.join(dir, provider + ".exe")))
      return path.join(dir, provider + ".exe");
  const packageName =
    provider === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
  function find(dir, depth = 0) {
    if (depth > 7 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === provider + ".exe")
        return path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = find(path.join(dir, entry.name), depth + 1);
        if (hit) return hit;
      }
    }
  }
  for (const dir of dirs) {
    const hit = find(path.join(dir, "node_modules", packageName));
    if (hit) return hit;
  }
  return provider + ".exe";
}
export function desktopServer(env = process.env) {
  const base = path.join(
    env.CODEX_HOME || path.join(homedir(), ".codex"),
    "plugins",
    "cache",
    "openai-bundled",
    "codex-app-tools",
  );
  if (!existsSync(base))
    throw new Error("Codex desktop app-tools plugin is not installed");
  const file = readdirSync(base)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((v) => path.join(base, v, "server.mjs"))
    .find(existsSync);
  if (!file) throw new Error("Codex desktop app-tools server is unavailable");
  return file;
}
export function validateConnection(value) {
  if (value?.kind === "desktop") {
    if (!UUID.test(value.origin || ""))
      throw new Error("Invalid originating thread");
    if (typeof value.pipe !== "string")
      throw new Error("Missing desktop connection");
    if (process.platform === "win32") {
      if (!/^\\\\\.\\pipe\\codex-browser-use-[a-f0-9-]{36}$/i.test(value.pipe))
        throw new Error("Invalid desktop pipe");
    } else {
      if (!path.isAbsolute(value.pipe))
        throw new Error("Desktop socket must be absolute");
      const stat = lstatSync(value.pipe);
      if (!stat.isSocket() || stat.uid !== process.getuid())
        throw new Error("Desktop socket must belong to the current user");
    }
    return { kind: "desktop", origin: value.origin, pipe: value.pipe };
  }
  if (value?.kind === "appserver") {
    const url = new URL(value.url);
    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Use a local ws://127.0.0.1:PORT Codex endpoint");
    return { kind: "appserver", url: url.href };
  }
  throw new Error("Unsupported connection");
}
export class Providers {
  constructor(store) {
    this.store = store;
    this.sessions = [];
    this.health = {};
    this.clients = new Map();
    this.connecting = new Map();
  }
  async client(key, create) {
    if (this.connecting.has(key)) return this.connecting.get(key);
    let client = this.clients.get(key);
    if (!client || client.closed) {
      client?.close();
      const pending = create()
        .then((value) => {
          this.clients.set(key, value);
          return value;
        })
        .finally(() => this.connecting.delete(key));
      this.connecting.set(key, pending);
      return pending;
    }
    return client;
  }
  async mcp(key, command, args, env = process.env) {
    return this.client(key, async () => {
      const client = new StdioRpc(command, args, { env });
      try {
        return await client.initialize();
      } catch (e) {
        client.close();
        throw e;
      }
    });
  }
  async desktop(connection) {
    return this.mcp(
      "desktop:" + connection.pipe,
      process.execPath,
      [desktopServer()],
      {
        ...process.env,
        CODEX_APP_TOOLS_PIPE_PATH: connection.pipe,
        CODEX_THREAD_ID: connection.origin,
      },
    );
  }
  async appserver(connection) {
    if (connection.kind === "daemon")
      return this.client("daemon", async () => {
        const client = new StdioRpc(executable("codex"), [
          "app-server",
          "proxy",
        ]);
        try {
          return await client.initialize("codex");
        } catch (e) {
          client.close();
          throw e;
        }
      });
    return this.client(connection.url, () =>
      new WebSocketRpc().connect(connection.url),
    );
  }
  async discover() {
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      let result;
      do {
        this.dirty = false;
        result = await this._discover();
      } while (this.dirty);
      return result;
    })().finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }
  async _discover() {
    const fresh = [];
    this.health = {};
    const jobs = [
      this.check("claude", async () => {
        const { stdout } = await exec(
          executable("claude"),
          ["agents", "--json"],
          { windowsHide: true, timeout: 10000, maxBuffer: 2 ** 20 },
        );
        const rows = JSON.parse(stdout);
        if (!Array.isArray(rows))
          throw new Error("Unsupported Claude session directory");
        fresh.push(
          ...rows
            .filter((s) => UUID.test(s.sessionId))
            .map((s) => ({
              id: `claude:${s.sessionId}`,
              nativeId: s.sessionId,
              provider: "claude",
              title: s.name || s.sessionId,
              cwd: s.cwd,
              status: s.status,
              transport: "claude-native",
              route: { kind: "claude" },
            })),
        );
      }),
    ];
    const connections = this.store
      .connections()
      .filter((c) => c.kind !== "identity");
    const control = path.join(
      process.env.CODEX_HOME || path.join(homedir(), ".codex"),
      "app-server-control",
      "app-server-control.sock",
    );
    if (existsSync(control)) connections.push({ kind: "daemon" });
    for (const connection of connections) {
      const name =
        connection.kind === "desktop"
          ? "desktop:" + connection.origin
          : connection.url || "codex-daemon";
      jobs.push(
        this.check(name, async () => {
          if (connection.kind === "desktop") {
            const client = await this.desktop(connection);
            const result = await client.tool(
              "list_threads",
              { limit: 50 },
              { "openai/threadId": connection.origin },
            );
            const rows = [
              ...(result.pinnedThreads || []),
              ...(result.threads || []),
            ];
            if (!rows.some((s) => s.id === connection.origin))
              throw new Error(
                "Saved desktop connection is stale; reconnect from a current thread",
              );
            fresh.push(
              ...rows
                .filter(
                  (s) =>
                    s.kind !== "chatgpt" &&
                    UUID.test(s.id) &&
                    (!s.hostId || s.hostId === "local"),
                )
                .map((s) => ({
                  id: `codex:${s.id}`,
                  nativeId: s.id,
                  provider: "codex",
                  title: s.title || s.id,
                  cwd: s.cwd,
                  status: s.status,
                  transport: "codex-desktop",
                  route: connection,
                })),
            );
          } else {
            const client = await this.appserver(connection);
            let cursor;
            let count = 0;
            do {
              const page = await client.request("thread/loaded/list", {
                ...(cursor ? { cursor } : {}),
                limit: 100,
              });
              if (!Array.isArray(page.data))
                throw new Error("Unsupported Codex loaded-thread directory");
              for (const id of page.data)
                if (UUID.test(id)) {
                  const { thread } = await client.request("thread/read", {
                    threadId: id,
                    includeTurns: false,
                  });
                  fresh.push({
                    id: `codex:${id}`,
                    nativeId: id,
                    provider: "codex",
                    title: thread.name || thread.preview?.slice(0, 100) || id,
                    cwd: thread.cwd,
                    status: thread.status?.type || "loaded",
                    transport: "codex-appserver",
                    route: connection,
                  });
                }
              cursor = page.nextCursor;
            } while (cursor && ++count < 10);
          }
        }),
      );
    }
    await Promise.all(jobs);
    // Prefer the app server that owns a loaded thread; never resume a second runtime.
    fresh.sort(
      (a, b) =>
        (a.transport === "codex-appserver" ? -1 : 0) -
        (b.transport === "codex-appserver" ? -1 : 0),
    );
    this.sessions = [
      ...new Map(
        fresh
          .slice()
          .reverse()
          .map((s) => [s.id, s]),
      ).values(),
    ];
    this.health.codex = this.sessions.some((s) => s.provider === "codex")
      ? { ok: true }
      : {
          ok: false,
          error:
            "No reachable Codex sessions. Connect from a desktop thread, or register a local app server with a loaded thread.",
        };
    return this.publicSessions();
  }
  async check(name, fn) {
    try {
      await fn();
      this.health[name] = { ok: true };
    } catch (e) {
      this.health[name] = { ok: false, error: e.message.slice(0, 300) };
    }
  }
  publicSessions() {
    return this.sessions.map(({ route, nativeId, ...session }) => session);
  }
  async send(target, message) {
    if (target.route.kind === "claude") {
      const client = await this.mcp("claude", executable("claude"), [
        "mcp",
        "serve",
      ]);
      const { listing } = await client.tool("ListAgents", {});
      // Revalidate the requested UUID before using its freshly listed address.
      const { stdout } = await exec(
        executable("claude"),
        ["agents", "--json"],
        { windowsHide: true, timeout: 10000, maxBuffer: 2 ** 20 },
      );
      const address = claudeAddress(
        listing,
        JSON.parse(stdout),
        target.nativeId,
      );
      const receipt = await client.tool("SendMessage", {
        to: address,
        message,
        summary: "OpenSwarm peer message",
      });
      if (receipt.success === false)
        throw new DeliveryError(
          receipt.message || "Claude refused delivery",
          "rejected",
        );
      return {
        provider: "claude",
        messageId: receipt.msg_id,
        detail: String(receipt.message || "accepted").slice(0, 1000),
      };
    }
    if (target.route.kind === "desktop") {
      const client = await this.desktop(target.route);
      const native = await client.tool(
        "send_message_to_thread",
        { threadId: target.nativeId, prompt: message },
        { "openai/threadId": target.route.origin },
      );
      return {
        provider: "codex",
        threadId: target.nativeId,
        detail: String(native.status || "accepted").slice(0, 1000),
      };
    }
    const client = await this.appserver(target.route);
    const { data } = await client.request("thread/loaded/list", {
      limit: 1000,
    });
    if (!data?.includes(target.nativeId))
      throw new DeliveryError(
        "Codex thread is no longer loaded; reopen it in Codex",
        "unavailable",
      );
    const { turn } = await client.request(
      "turn/start",
      {
        threadId: target.nativeId,
        input: [{ type: "text", text: message, text_elements: [] }],
      },
      45000,
    );
    return { provider: "codex", turnId: turn?.id, status: turn?.status };
  }
  close() {
    for (const c of this.clients.values()) c.close();
  }
}
