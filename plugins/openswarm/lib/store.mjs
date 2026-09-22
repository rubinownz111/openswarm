import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { SESSION, text, assertObject } from "./config.mjs";

const decode = (row) => row && { ...JSON.parse(row.data), seq: row.seq };
export class Store {
  constructor(dir) {
    this.db = new DatabaseSync(path.join(dir, "messages.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        sender TEXT NOT NULL, recipient TEXT NOT NULL, retry_key TEXT NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL, UNIQUE(sender,retry_key));
      CREATE INDEX IF NOT EXISTS message_queue ON messages(status,recipient,seq);
      CREATE INDEX IF NOT EXISTS message_sender ON messages(sender,seq);
      CREATE INDEX IF NOT EXISTS message_recipient ON messages(recipient,seq);
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    for (const row of this.db
      .prepare("SELECT * FROM messages WHERE status='sending'")
      .all())
      this.update(row.id, {
        status: "unknown",
        error:
          "Broker stopped during delivery. Check the recipient before sending again.",
      });
  }
  get(id) {
    return decode(
      this.db.prepare("SELECT seq,data FROM messages WHERE id=?").get(id),
    );
  }
  enqueue(input) {
    assertObject(input);
    let { from, to, key, replyTo } = input;
    const body = text(input.text, "text", 24000);
    if (!SESSION.test(from || ""))
      throw new Error("Use your real sender ID from whoami or SessionStart");
    if (replyTo) {
      const original = this.get(text(replyTo, "replyTo", 100));
      if (!original) throw new Error("Original message not found");
      if (from !== original.to)
        throw new Error("Only the addressed recipient can reply");
      to = original.from;
      key ??=
        "reply:" +
        createHash("sha256")
          .update(replyTo + "\n" + body)
          .digest("hex");
    }
    if (!SESSION.test(to || "") || to === from)
      throw new Error("Choose a different exact peer ID from list");
    text(key, "key", 200);
    const existing = decode(
      this.db
        .prepare("SELECT seq,data FROM messages WHERE sender=? AND retry_key=?")
        .get(from, key),
    );
    if (existing) {
      if (
        existing.to !== to ||
        existing.text !== body ||
        existing.replyTo !== replyTo
      )
        throw new Error("Retry key already used for different content");
      return existing;
    }
    if (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM messages WHERE status IN ('queued','sending')",
        )
        .get().n >= 500
    )
      throw new Error("Queue full; wait for delivery");
    const now = Date.now();
    const message = {
      id: randomUUID(),
      from,
      to,
      text: body,
      key,
      ...(replyTo ? { replyTo } : {}),
      status: "queued",
      createdAt: now,
      expiresAt: now + 24 * 3600_000,
      attempts: 0,
    };
    this.db
      .prepare(
        "INSERT INTO messages(id,sender,recipient,retry_key,status,data) VALUES(?,?,?,?,?,?)",
      )
      .run(message.id, from, to, key, message.status, JSON.stringify(message));
    return this.get(message.id);
  }
  update(id, patch) {
    const old = this.get(id);
    if (!old) throw new Error("Message not found");
    const next = { ...old, ...patch, updatedAt: Date.now() };
    this.db
      .prepare("UPDATE messages SET status=?,data=? WHERE id=?")
      .run(next.status, JSON.stringify(next), id);
    return next;
  }
  queued() {
    return this.db
      .prepare(
        "SELECT seq,data FROM messages WHERE status='queued' ORDER BY seq",
      )
      .all()
      .map(decode);
  }
  history({ session, before, limit = 50 } = {}) {
    if (session && !SESSION.test(session))
      throw new Error("Invalid session ID");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("limit must be 1–100");
    if (before != null && (!Number.isSafeInteger(before) || before < 1))
      throw new Error("Invalid cursor");
    const conditions = ["seq < ?"];
    const args = [before ?? Number.MAX_SAFE_INTEGER];
    if (session) {
      conditions.push("(sender=? OR recipient=?)");
      args.push(session, session);
    }
    const rows = this.db
      .prepare(
        `SELECT seq,data FROM messages WHERE ${conditions.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...args, limit)
      .map(decode);
    const page = [];
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (page.length && bytes + size > 256 * 1024) break;
      page.push(row);
      bytes += size;
    }
    const more = page.length < rows.length || rows.length === limit;
    return {
      messages: page.reverse(),
      before: more && page.length ? page[0].seq : null,
    };
  }
  register(id, data) {
    this.db
      .prepare("INSERT OR REPLACE INTO connections VALUES(?,?)")
      .run(id, JSON.stringify(data));
    // Bounded native registration cache, newest registrations win.
    this.db.exec(
      "DELETE FROM connections WHERE rowid NOT IN (SELECT rowid FROM connections ORDER BY rowid DESC LIMIT 32)",
    );
  }
  connections() {
    return this.db
      .prepare("SELECT data FROM connections ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  close() {
    this.db.close();
  }
}
