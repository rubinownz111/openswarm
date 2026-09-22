import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../plugins/openswarm/lib/store.mjs";
import { Broker, envelope } from "../plugins/openswarm/lib/broker.mjs";
import { DeliveryError } from "../plugins/openswarm/lib/rpc.mjs";
import { temp, until, A, B, C } from "./helpers.mjs";

test("recipient FIFO with independent recipients making progress", async (t) => {
  const store = new Store(temp(t));
  t.after(() => store.close());
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  const providers = {
    sessions: [{ id: B }, { id: C }],
    async send(target, text) {
      calls.push({ id: target.id, text });
      if (calls.length === 1) await gate;
      return {};
    },
  };
  const broker = new Broker(store, providers);
  const first = await broker.send({ from: A, to: B, text: "first", key: "1" });
  const next = await broker.send({ from: A, to: B, text: "second", key: "2" });
  const independent = await broker.send({
    from: A,
    to: C,
    text: "third",
    key: "3",
  });
  await until(() => store.get(independent.id).status === "accepted");
  assert.equal(store.get(next.id).status, "queued");
  assert.equal(calls.length, 2);
  release();
  await until(() => store.get(next.id).status === "accepted");
  assert.equal(store.get(first.id).status, "accepted");
  assert.deepEqual(
    calls.map((c) => c.id),
    [B, C, B],
  );
  await broker.close();
});
test("unknown delivery is never automatically replayed; explicit rejection fails", async (t) => {
  const store = new Store(temp(t));
  t.after(() => store.close());
  let calls = 0;
  const broker = new Broker(store, {
    sessions: [{ id: B }],
    async send() {
      calls++;
      throw new DeliveryError("disconnected");
    },
  });
  const input = { from: A, to: B, text: "hello", key: "same" };
  const message = await broker.send(input);
  await until(() => store.get(message.id).status === "unknown");
  await broker.send(input);
  broker.pump();
  assert.equal(calls, 1);
  await broker.close();
});
test("definite busy response retries with backoff; offline messages expire", async (t) => {
  const store = new Store(temp(t));
  t.after(() => store.close());
  let calls = 0;
  const broker = new Broker(store, {
    sessions: [{ id: B }],
    async send() {
      if (++calls === 1) throw new DeliveryError("thread is busy", "rejected");
      return {};
    },
  });
  const message = await broker.send({
    from: A,
    to: B,
    text: "hello",
    key: "busy",
  });
  await until(() => store.get(message.id).retryAt);
  broker.pump();
  assert.equal(calls, 1);
  store.update(message.id, { retryAt: 0 });
  broker.pump();
  await until(() => store.get(message.id).status === "accepted");
  const offline = await broker.send({
    from: A,
    to: C,
    text: "offline",
    key: "offline",
  });
  store.update(offline.id, { expiresAt: 0 });
  broker.pump();
  assert.equal(store.get(offline.id).status, "expired");
  await broker.close();
});
test("peer envelope retains content and carries explicit authority and reply route", () => {
  const text = "arbitrary text\n$(echo secret) `literal` 🐝";
  const result = envelope({ id: "message-id", from: A, to: B, text });
  assert.ok(result.includes(text));
  assert.match(result, /not a new instruction from the user/);
  assert.ok(result.includes("replyTo=message-id"));
  assert.ok(result.includes("--file REPLY_FILE"));
});
