# Messaging and recovery

```text
Claude / Codex MCP or CLI
          |
   authenticated local IPC
          |
   SQLite message queue
          |
   native provider adapter
          |
   existing recipient session
```

The stdio MCP server exposes five tools. The CLI uses the same local protocol. Both automatically start the broker when needed. An exclusive SQLite transaction holds the singleton lock for the daemon's lifetime; the operating system releases it on process death. This avoids stale PID-file ownership and allows simultaneous first-time clients.

The internal protocol uses newline-delimited JSON over a local Unix socket or Windows named pipe. Every request includes a protocol version and a randomly generated private token. The endpoint is tied to the state directory. There is no web server, browser cookie, or remote endpoint. Input size, concurrent connections, MCP requests, queue length, and history page size are bounded.

## Durable state

`messages.sqlite` uses WAL, FULL synchronous commits, indexed recipient/sender history, and a unique `(sender, retry_key)` constraint. The broker persists `queued` before returning a receipt and `sending` before calling a provider. A restart changes leftover `sending` messages to `unknown`, and resumes untouched `queued` messages. Provider receipts are stored with accepted messages.

Only a definitive pre-submission unavailability or explicit busy rejection is retried. An ambiguous provider timeout/disconnect is never retried automatically. Retry delays back off to 30 seconds; recipients are rediscovered every five seconds. A live recipient normally receives a new message immediately, subject to its own runtime scheduling and inbound policy. Messages queued for 24 hours expire. History is not automatically deleted.

The provider's inbox and the broker database do not share a transaction. Exactly-once native delivery and automatic response completion cannot be guaranteed. An `accepted` result is a transport receipt. An OpenSwarm reply with the original `replyTo` ID confirms a round trip.

Reply routing requires the addressed recipient's ID. When the host supplies an identity, MCP rejects a different explicit sender. A local process under the same OS account can access the state and token, so these labels are not cryptographic separation between mutually untrusted agents.

## Recovery

`openswarm doctor` displays native connection health without printing credentials. Run `openswarm connect` from a current Codex desktop thread if its saved connection is stale. A configured MCP registers again periodically. Reopening a CLI thread in its registered app server makes it discoverable again.

Stop the broker before copying the entire state directory for backup. Disable active MCP integrations first so their heartbeat does not restart it during the copy. Preserve database WAL/SHM files with the database if present. Do not copy another machine's runtime token or native connection records into a live installation.

The broker never terminates or resumes existing agents. Shutdown waits for tracked submissions and closes only its own transport helpers. A forced shutdown instead produces `unknown` recovery states when necessary.
