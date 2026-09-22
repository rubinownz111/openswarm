#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { VERSION, identity } from "../lib/config.mjs";
import { ensure, request, serve } from "../lib/service.mjs";

const print = (value) =>
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries([
      ...[
        "from",
        "to",
        "text",
        "file",
        "key",
        "session",
        "before",
        "limit",
        "provider",
        "url",
        "seconds",
      ].map((k) => [k, { type: "string" }]),
      ...[
        "help",
        "version",
        "accept-claude-messages",
        "approve-codex-tools",
      ].map((k) => [k, { type: "boolean" }]),
    ]),
  });
  const [command = "help", id] = positionals;
  if (values.version) print({ version: VERSION });
  else if (values.help || command === "help")
    process.stdout.write(
      `OpenSwarm ${VERSION} — messages between existing Claude Code and Codex agents\n\n` +
        `  install [--provider all|claude|codex] [--accept-claude-messages] [--approve-codex-tools]\n` +
        `  mcp [--provider auto|claude|codex]   Run stdio MCP (auto-starts local broker)\n` +
        `  list                              Discover reachable peers\n` +
        `  whoami                            Read this session's inherited identity\n` +
        `  send --to ID --from ID --text TEXT --key KEY\n` +
        `  reply MESSAGE_ID --from ID --text TEXT\n` +
        `  messages [--session ID] [--before SEQ] [--limit 50]\n` +
        `  status MESSAGE_ID                 Inspect one delivery\n` +
        `  wait MESSAGE_ID [--seconds 30]     Wait for a peer reply (maximum 60 seconds)\n` +
        `  connect                           Register this Codex desktop connection\n` +
        `  connect --url ws://127.0.0.1:PORT   Attach to an existing local Codex app server\n` +
        `  doctor | serve | stop\n\nUse --file PATH instead of --text for arbitrary text. No shell interpolation.\n`,
    );
  else if (command === "serve") await serve();
  else if (command === "mcp") {
    const { serveMcp } = await import("../lib/mcp-server.mjs");
    await serveMcp(values.provider);
  } else if (command === "install") {
    const { install } = await import("../lib/install.mjs");
    print(await install(values));
  } else if (command === "hook") {
    const { sessionHook } = await import("../lib/install.mjs");
    await sessionHook(values.provider);
  } else if (command === "whoami") print({ id: identity() });
  else if (command === "stop") print(await request("stop"));
  else {
    if (
      ![
        "list",
        "doctor",
        "connect",
        "send",
        "reply",
        "messages",
        "status",
        "wait",
      ].includes(command)
    )
      throw new Error("Unknown command; use openswarm --help");
    await ensure();
    if (
      process.env.CODEX_APP_TOOLS_PIPE_PATH &&
      identity()?.startsWith("codex:")
    )
      await request("register", {
        kind: "desktop",
        pipe: process.env.CODEX_APP_TOOLS_PIPE_PATH,
        origin: process.env.CODEX_THREAD_ID,
      });
    if (command === "list" || command === "doctor")
      print(await request(command));
    else if (command === "connect") {
      if (values.url)
        print(
          await request("register", { kind: "appserver", url: values.url }),
        );
      else if (!process.env.CODEX_APP_TOOLS_PIPE_PATH)
        throw new Error(
          "Run connect from a Codex desktop thread, or pass --url",
        );
      else print({ registered: true });
    } else if (command === "messages")
      print(
        await request("messages", {
          session: values.session,
          before: values.before ? Number(values.before) : undefined,
          limit: values.limit ? Number(values.limit) : 50,
        }),
      );
    else if (command === "status") print(await request("get", { id }));
    else if (command === "wait") {
      const seconds = Number(values.seconds ?? 30);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
        throw new Error("seconds must be 0–60");
      const original = await request("get", { id });
      if (!original) throw new Error("Message not found");
      const until = Date.now() + seconds * 1000;
      let reply;
      do {
        const history = await request("messages", {
          session: original.from,
          limit: 100,
        });
        reply = history.messages.find((m) => m.replyTo === id);
        if (reply || Date.now() >= until) break;
        await delay(500);
      } while (true);
      print(reply || { waiting: true, message: await request("get", { id }) });
    } else {
      if (values.file && values.text)
        throw new Error("Choose --text or --file");
      print(
        await request("send", {
          from: values.from || identity(),
          to: values.to,
          text: values.file ? readFileSync(values.file, "utf8") : values.text,
          ...(command === "reply"
            ? { replyTo: id, key: values.key }
            : { key: values.key || randomUUID() }),
        }),
      );
    }
  }
} catch (e) {
  process.stderr.write(`OpenSwarm: ${e.message}\n`);
  process.exitCode = 1;
}
