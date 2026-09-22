import test from "node:test";
import { claudeAddress } from "../plugins/openswarm/lib/providers.mjs";
import assert from "node:assert/strict";

test("Claude addresses are revalidated against UUIDs after renames and name reuse", () => {
  const listing = "worker [abc123]  ·  bg  ·  idle";
  const agents = [{ sessionId: "wanted", name: "worker" }];
  assert.equal(claudeAddress(listing, agents, "wanted"), "worker [abc123]");
  assert.throws(
    () =>
      claudeAddress(
        listing,
        [{ sessionId: "replacement", name: "worker" }],
        "wanted",
      ),
    /unavailable/,
  );
  assert.throws(
    () =>
      claudeAddress(
        listing,
        [...agents, { sessionId: "other", name: "worker" }],
        "wanted",
      ),
    /ambiguous/,
  );
  assert.throws(
    () =>
      claudeAddress(
        listing,
        [{ sessionId: "wanted", name: "renamed" }],
        "wanted",
      ),
    /renamed/,
  );
});
import { PassThrough } from "node:stream";
import { identity } from "../plugins/openswarm/lib/config.mjs";
import {
  Providers,
  validateConnection,
} from "../plugins/openswarm/lib/providers.mjs";
import { lines, Rpc, DeliveryError } from "../plugins/openswarm/lib/rpc.mjs";
import { mergeClaudeSettings } from "../plugins/openswarm/lib/install.mjs";
import { A, B } from "./helpers.mjs";

test("Claude launched by Codex does not inherit the parent identity", () => {
  const env = { CODEX_THREAD_ID: B.slice(6) };
  assert.equal(identity(env), B);
  assert.equal(identity({ ...env, OPENSWARM_PROVIDER: "claude" }), null);
  assert.equal(
    identity({ ...env, CLAUDE_CODE_MESSAGING_SOCKET: "some-socket" }),
    null,
  );
  assert.equal(identity({ ...env, OPENSWARM_SESSION_ID: A }), A);
});
test("provider connections are local only", () => {
  assert.equal(
    validateConnection({ kind: "appserver", url: "ws://127.0.0.1:4500" }).url,
    "ws://127.0.0.1:4500/",
  );
  for (const url of [
    "ws://example.com:4500",
    "ws://127.0.0.1:4500/private",
    "ws://user:pass@127.0.0.1:4500",
    "http://127.0.0.1:4500",
  ])
    assert.throws(() => validateConnection({ kind: "appserver", url }));
});
test("concurrent provider calls share one initialization", async () => {
  const providers = new Providers({ connections: () => [] });
  let calls = 0;
  const create = async () => {
    calls++;
    return { closed: false };
  };
  const clients = await Promise.all(
    Array.from({ length: 10 }, () => providers.client("same", create)),
  );
  assert.equal(calls, 1);
  assert.equal(new Set(clients).size, 1);
});
test("framing preserves split UTF-8 and bounds untrusted output", () => {
  const stream = new PassThrough();
  const received = [];
  const errors = [];
  lines(
    stream,
    (m) => received.push(m),
    (e) => errors.push(e),
    100,
  );
  const raw = Buffer.from(JSON.stringify({ text: "🐝你好" }) + "\n");
  for (const byte of raw) stream.write(Buffer.from([byte]));
  assert.deepEqual(received, [{ text: "🐝你好" }]);
  stream.write(Buffer.alloc(101, 65));
  assert.equal(errors.length, 1);
  stream.destroy();
});
test("provider errors distinguish explicit rejection from uncertainty", async () => {
  const rpc = new Rpc();
  let message;
  rpc.write = (m) => (message = m);
  const rejected = rpc.request("send");
  rpc.receive({ id: message.id, error: { message: "refused" } });
  await assert.rejects(rejected, (e) => e.outcome === "rejected");
  const unknown = rpc.request("send", {}, 5);
  await assert.rejects(unknown, (e) => e.outcome === "unknown");
  rpc.fail(new DeliveryError("closed"));
  await assert.rejects(rpc.request("send"), (e) => e.outcome === "unavailable");
});
test("Claude setup preserves unrelated hooks and permissions and is repeatable", () => {
  const old = {
    permissions: { defaultMode: "default" },
    crossSessionInbound: "hold",
    hooks: {
      Stop: [{ hooks: [{ command: "keep-stop" }] }],
      SessionStart: [
        { matcher: "startup", hooks: [{ command: "keep-start" }] },
      ],
    },
  };
  const next = mergeClaudeSettings(old, "new-command");
  assert.deepEqual(next.permissions, old.permissions);
  assert.equal(next.crossSessionInbound, "hold");
  assert.deepEqual(next.hooks.Stop, old.hooks.Stop);
  assert.deepEqual(next.hooks.SessionStart[0], old.hooks.SessionStart[0]);
  assert.deepEqual(mergeClaudeSettings(next, "new-command"), next);
  assert.equal(
    mergeClaudeSettings(next, "new-command", true).crossSessionInbound,
    "accept",
  );
  assert.equal(old.hooks.SessionStart.length, 1);
});
test("Codex app server messages only the already-loaded thread and never changes permissions", async () => {
  const providers = new Providers({ connections: () => [] });
  const calls = [];
  providers.appserver = async () => ({
    async request(method, params) {
      calls.push({ method, params });
      return method === "thread/loaded/list"
        ? { data: [B.slice(6)] }
        : { turn: { id: "turn-1", status: "inProgress" } };
    },
  });
  const result = await providers.send(
    { nativeId: B.slice(6), route: { kind: "appserver" } },
    "payload",
  );
  assert.equal(result.turnId, "turn-1");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["thread/loaded/list", "turn/start"],
  );
  assert.deepEqual(Object.keys(calls[1].params).sort(), ["input", "threadId"]);
  await assert.rejects(
    providers.send(
      { nativeId: "unloaded", route: { kind: "appserver" } },
      "payload",
    ),
    /no longer loaded/,
  );
});
