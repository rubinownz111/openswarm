import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../plugins/openswarm/lib/store.mjs";
import { temp, A, B, C } from "./helpers.mjs";

test("durable retry keys deduplicate identical sends and reject changed content", (t) => {
  const dir = temp(t);
  let store = new Store(dir);
  const input = { from: A, to: B, text: "hello 🐝\n第二行", key: "same" };
  const first = store.enqueue(input);
  store.close();
  store = new Store(dir);
  t.after(() => store.close());
  assert.equal(store.enqueue(input).id, first.id);
  assert.throws(() => store.enqueue({ ...input, to: C }), /different content/);
  assert.throws(
    () => store.enqueue({ ...input, text: "different" }),
    /different content/,
  );
  assert.equal(store.enqueue({ ...input, from: C }).status, "queued");
});
test("only recipient may reply; identical replies are deduplicated", (t) => {
  const store = new Store(temp(t));
  t.after(() => store.close());
  const original = store.enqueue({
    from: A,
    to: B,
    text: "question",
    key: "q",
  });
  assert.throws(
    () => store.enqueue({ from: C, replyTo: original.id, text: "forged" }),
    /addressed recipient/,
  );
  const reply = store.enqueue({
    from: B,
    replyTo: original.id,
    text: "answer",
  });
  assert.equal(reply.to, A);
  assert.equal(
    store.enqueue({ from: B, replyTo: original.id, text: "answer" }).id,
    reply.id,
  );
});
test("a crash during delivery becomes unknown; queued work survives", (t) => {
  const dir = temp(t);
  let store = new Store(dir);
  const a = store.enqueue({ from: A, to: B, text: "maybe sent", key: "1" });
  const b = store.enqueue({ from: A, to: B, text: "waiting", key: "2" });
  store.update(a.id, { status: "sending" });
  store.close();
  store = new Store(dir);
  t.after(() => store.close());
  assert.equal(store.get(a.id).status, "unknown");
  assert.deepEqual(
    store.queued().map((m) => m.id),
    [b.id],
  );
});
test("indexed history pages do not duplicate or skip messages", (t) => {
  const store = new Store(temp(t));
  t.after(() => store.close());
  const ids = Array.from(
    { length: 9 },
    (_, i) =>
      store.enqueue({ from: A, to: B, text: String(i), key: String(i) }).id,
  );
  const first = store.history({ session: A, limit: 4 });
  const second = store.history({ session: A, limit: 4, before: first.before });
  const third = store.history({ session: A, limit: 4, before: second.before });
  assert.deepEqual(
    [...third.messages, ...second.messages, ...first.messages].map((m) => m.id),
    ids,
  );
  assert.equal(third.before, null);
});
test("reject invalid payloads and cap pending queue", (t) => {
  const store = new Store(temp(t));
  t.after(() => store.close());
  const valid = { from: A, to: B, text: "valid", key: "1" };
  for (const patch of [
    { from: "fake" },
    { to: A },
    { text: "" },
    { text: "a".repeat(24001) },
    { text: "\0" },
    { key: "" },
  ])
    assert.throws(() => store.enqueue({ ...valid, ...patch }));
  for (let i = 0; i < 500; i++) store.enqueue({ ...valid, key: String(i) });
  assert.throws(
    () => store.enqueue({ ...valid, key: "overflow" }),
    /Queue full/,
  );
  assert.ok(store.enqueue(valid)); // Retry still succeeds when queue is full.
});
