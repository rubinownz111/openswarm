import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  unlinkSync,
  chmodSync,
  openSync,
  closeSync,
  statSync,
  renameSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CLI,
  VERSION,
  PROTOCOL,
  stateDir,
  privateDir,
  endpoint,
  atomicJson,
  readJson,
  assertObject,
  SESSION,
} from "./config.mjs";
import { Store } from "./store.mjs";
import { Providers, validateConnection } from "./providers.mjs";
import { Broker } from "./broker.mjs";
import { lines } from "./rpc.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function runtime(dir) {
  const value = readJson(path.join(dir, "runtime.json"));
  if (
    !value ||
    value.protocol !== PROTOCOL ||
    value.endpoint !== endpoint(dir) ||
    !/^[a-f0-9]{64}$/.test(value.token)
  )
    throw new Error("OpenSwarm is not running or needs an upgrade");
  return value;
}
export async function request(
  method,
  params = {},
  { dir = stateDir(), timeout = 20000 } = {},
) {
  const run = runtime(dir);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(run.endpoint);
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "OpenSwarm request timed out. Reuse the same retry key if sending.",
          ),
        ),
      timeout,
    );
    socket.on("error", (e) => finish(e));
    socket.on("end", () =>
      finish(
        new Error(
          "OpenSwarm disconnected; inspect message status before retrying",
        ),
      ),
    );
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          id: 1,
          protocol: PROTOCOL,
          token: run.token,
          method,
          params,
        }) + "\n",
      ),
    );
    lines(
      socket,
      (response) =>
        response.error
          ? finish(new Error(response.error))
          : finish(null, response.result),
      finish,
      4 * 2 ** 20,
    );
  });
}
export async function ensure(dir = stateDir()) {
  privateDir(dir);
  try {
    return await request("ping", {}, { dir, timeout: 700 });
  } catch {
    /* Serialized by SQLite's OS lock in the child. */
  }
  const logPath = path.join(dir, "daemon.log");
  try {
    if (statSync(logPath).size > 1024 * 1024)
      renameSync(logPath, logPath + ".old");
  } catch {
    /* First start. */
  }
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [CLI, "serve"], {
    env: { ...process.env, OPENSWARM_HOME: dir },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log, "ipc"],
  });
  child.on("error", () => {});
  child.unref();
  closeSync(log);
  // Wait for our own startup attempt to finish, even if a competing daemon
  // answers first. A delayed loser must not start after the caller stops the winner.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 6000);
    const done = () => {
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      resolve();
    };
    child.once("message", done);
    child.once("exit", done);
    child.once("error", done);
  });
  for (let i = 0; i < 60; i++) {
    await delay(100);
    try {
      return await request("ping", {}, { dir, timeout: 500 });
    } catch {
      /* Wait for the winning daemon. */
    }
  }
  throw new Error(
    "OpenSwarm did not start. Run openswarm serve to see the diagnostic.",
  );
}
export async function serve({
  dir = stateDir(),
  providersFactory = (store) => new Providers(store),
} = {}) {
  privateDir(dir);
  // An OS-backed SQLite lock avoids stale PID files, PID reuse, and parallel-start races on all three OSes.
  const lock = new DatabaseSync(path.join(dir, "daemon-lock.sqlite"));
  try {
    lock.exec(
      "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS singleton(id INTEGER);",
    );
  } catch (e) {
    lock.close();
    if (/locked/.test(e.message)) {
      process.send?.({ started: false });
      return;
    }
    throw e;
  }
  const store = new Store(dir),
    providers = providersFactory(store),
    broker = new Broker(store, providers);
  const token = randomBytes(32).toString("hex");
  const address = endpoint(dir);
  const sockets = new Set();
  let stopping = false;
  if (process.platform !== "win32") {
    try {
      unlinkSync(address);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const server = net.createServer((socket) => {
    if (sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(25000, () => socket.destroy());
    let used = false;
    lines(
      socket,
      async (input) => {
        if (used) {
          socket.destroy();
          return;
        }
        used = true;
        try {
          assertObject(input);
          if (input.protocol !== PROTOCOL || !equal(input.token, token))
            throw new Error("Unauthorized");
          const result = await dispatch(
            input.method,
            assertObject(input.params || {}),
          );
          if (!socket.destroyed)
            socket.end(JSON.stringify({ id: input.id, result }) + "\n");
          if (input.method === "stop") void close();
        } catch (e) {
          if (!socket.destroyed)
            socket.end(
              JSON.stringify({ id: input?.id, error: e.message }) + "\n",
            );
        }
      },
      () => socket.destroy(),
      128 * 1024,
    );
  });
  async function dispatch(method, params) {
    if (stopping) throw new Error("OpenSwarm is stopping");
    if (method === "ping")
      return { version: VERSION, protocol: PROTOCOL, pid: process.pid };
    if (method === "stop") return { stopped: true };
    if (method === "list" || method === "doctor") {
      await providers.discover();
      broker.pump();
      return {
        version: VERSION,
        sessions: providers.publicSessions(),
        health: providers.health,
      };
    }
    if (method === "register") {
      const connection = validateConnection(params);
      store.register(connection.origin || connection.url, connection);
      providers.dirty = true;
      // Registration never swaps an in-flight connection or restarts a provider.
      return { registered: true };
    }
    if (method === "identify") {
      if (params.id) {
        if (
          !SESSION.test(params.id) ||
          typeof params.socket !== "string" ||
          params.socket.length > 1000
        )
          throw new Error("Invalid session registration");
        store.register("identity:" + params.socket, {
          kind: "identity",
          id: params.id,
          socket: params.socket,
        });
      }
      return {
        id:
          store
            .connections()
            .find((c) => c.kind === "identity" && c.socket === params.socket)
            ?.id || null,
      };
    }
    if (method === "send") return broker.send(params);
    if (method === "messages") return store.history(params);
    if (method === "get") return store.get(params.id) || null;
    throw new Error("Unknown OpenSwarm method");
  }
  const timer = setInterval(() => {
    if (!stopping)
      void providers
        .discover()
        .then(() => broker.pump())
        .catch(() => {});
  }, 5000);
  const pumpTimer = setInterval(() => broker.pump(), 500);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  if (process.platform !== "win32") chmodSync(address, 0o600);
  atomicJson(path.join(dir, "runtime.json"), {
    version: VERSION,
    protocol: PROTOCOL,
    pid: process.pid,
    endpoint: address,
    token,
  });
  process.send?.({ started: true });
  void providers
    .discover()
    .then(() => broker.pump())
    .catch(() => {});
  async function close() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(pumpTimer);
    server.close();
    await broker.close();
    if (providers.discovering) await providers.discovering.catch(() => {});
    providers.close();
    for (const s of sockets) s.destroy();
    store.close();
    lock.close();
    // Do not unlink a socket after releasing the lock: a successor might already own it.
  }
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  return { close, server, store, broker };
}
