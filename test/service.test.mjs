import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { request, runtime } from "../plugins/openswarm/lib/service.mjs";
import { CLI } from "../plugins/openswarm/lib/config.mjs";
import { StdioRpc } from "../plugins/openswarm/lib/rpc.mjs";
import { temp, daemon, envFor, until, A, B } from "./helpers.mjs";

test("local IPC supports concurrent clients, UTF-8, durable receipts and replies", async (t) => {
  const dir = temp(t);
  await daemon(t, dir);
  const input = { from: A, to: B, text: "Hello 🐝\n你好", key: "shared" };
  const results = await Promise.all(
    Array.from({ length: 12 }, () => request("send", input, { dir })),
  );
  assert.equal(new Set(results.map((m) => m.id)).size, 1);
  const id = results[0].id;
  await until(
    async () => (await request("get", { id }, { dir })).status === "accepted",
  );
  const reply = await request(
    "send",
    { from: B, replyTo: id, text: "PONG" },
    { dir },
  );
  assert.equal(reply.to, A);
  assert.equal(
    (await request("messages", { session: A }, { dir })).messages.length,
    2,
  );
  assert.equal(
    readFileSync(path.join(dir, "attempts.txt"), "utf8").trim().split("\n")
      .length,
    2,
  );
});
test("IPC rejects missing credentials, wrong protocol and oversized frames without crashing", async (t) => {
  const dir = temp(t);
  await daemon(t, dir);
  const run = runtime(dir);
  const raw = (data) =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(run.endpoint);
      let output = "";
      socket.on("connect", () => socket.write(data));
      socket.on("data", (c) => (output += c));
      socket.on("close", () => resolve(output));
      socket.on("error", reject);
    });
  assert.match(
    await raw(
      JSON.stringify({
        method: "list",
        params: {},
        protocol: 1,
        token: "wrong",
      }) + "\n",
    ),
    /Unauthorized/,
  );
  assert.match(
    await raw(
      JSON.stringify({
        method: "list",
        params: {},
        protocol: 2,
        token: run.token,
      }) + "\n",
    ),
    /Unauthorized/,
  );
  assert.equal(await raw("x".repeat(140 * 1024)), "");
  assert.equal((await request("ping", {}, { dir })).protocol, 1);
});
test("daemon process crash leaves an uncertain message unknown and never replays it", async (t) => {
  const dir = temp(t);
  const child = await daemon(t, dir);
  const message = await request(
    "send",
    { from: A, to: B, text: "BLOCK_DELIVERY", key: "crash" },
    { dir },
  );
  await until(
    async () =>
      (await request("get", { id: message.id }, { dir })).status === "sending",
  );
  child.kill("SIGKILL");
  await until(() => child.exitCode !== null || child.signalCode !== null);
  await daemon(t, dir);
  assert.equal(
    (await request("get", { id: message.id }, { dir })).status,
    "unknown",
  );
  assert.equal(
    readFileSync(path.join(dir, "attempts.txt"), "utf8").trim().split("\n")
      .length,
    1,
  );
});
test("MCP handshakes, lists tools and rejects sender spoofing", async (t) => {
  const dir = temp(t);
  await daemon(t, dir);
  const client = new StdioRpc(
    process.execPath,
    [CLI, "mcp", "--provider", "codex"],
    { env: { ...envFor(dir), OPENSWARM_SESSION_ID: B } },
  );
  t.after(() => client.close());
  await client.initialize();
  assert.equal((await client.request("tools/list")).tools.length, 5);
  assert.equal((await client.tool("openswarm_whoami", {})).id, B);
  await assert.rejects(
    client.tool("openswarm_send", {
      from: A,
      to: B,
      text: "fake",
      key: "fake",
    }),
    /does not match/,
  );
  const message = await client.tool("openswarm_send", {
    to: A,
    text: "hello",
    key: "mcp",
  });
  assert.equal(message.from, B);
  await assert.rejects(
    client.tool("openswarm_send", {
      to: A,
      text: "hello",
      key: "mcp",
      unexpected: true,
    }),
    /Invalid arguments/,
  );
});
test("simultaneous auto-starts elect one daemon using OS locking", async (t) => {
  const dir = temp(t);
  const env = envFor(dir);
  const exec = promisify(execFile);
  t.after(async () => {
    try {
      await request("stop", {}, { dir });
      await until(async () => {
        try {
          await request("ping", {}, { dir, timeout: 100 });
          return false;
        } catch {
          return true;
        }
      });
    } catch {
      /* Already stopped. */
    }
  });
  const runs = await Promise.all(
    Array.from({ length: 6 }, () =>
      exec(process.execPath, [CLI, "messages"], {
        env,
        windowsHide: true,
        timeout: 15000,
      }),
    ),
  );
  assert.ok(runs.every((r) => JSON.parse(r.stdout).messages.length === 0));
  assert.ok((await request("ping", {}, { dir })).pid > 0);
});
