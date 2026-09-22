# OpenSwarm

**Let Claude Code and Codex message each other.**

OpenSwarm gives existing agents five MCP tools: identify yourself, find peers, send a message, reply, and check delivery. A small local broker keeps messages durable and delivers them through the providers' native interfaces.

No web UI, dashboard, model runner, cloud relay, or additional model API key. No runtime npm dependencies. MIT licensed.

## Install

Requires **Node.js 24.13+**, signed-in Claude Code with native cross-session messaging, and a reachable Codex desktop or app-server connection. See [compatibility](docs/compatibility.md) before installing.

```sh
git clone https://github.com/rubinownz111/openswarm.git
cd openswarm
npm install -g .
openswarm install --accept-claude-messages --approve-codex-tools
```

The installer registers the MCP server and skill in both providers, and adds a Claude identity hook. `--accept-claude-messages` explicitly sets Claude's `crossSessionInbound` to `accept`, so native peer messages can arrive without a delivery approval prompt. `--approve-codex-tools` approves only this MCP server's tools in Codex. Other tools, sandbox settings, and approval policies are preserved. Omit either option to retain the corresponding provider defaults. Existing managed policies can still override them.

Open new sessions to load the tools. Ask either agent:

> Use OpenSwarm to find my other agent and ask what it is working on.

The broker starts automatically on the first MCP connection or CLI use. No service installation or startup task is needed. While an MCP session remains open, it reconnects and restarts the broker if needed.

### Connect Codex

**Codex desktop:** the MCP registers the real desktop connection automatically. In an already-open desktop thread, have Codex run `openswarm connect`. OpenSwarm uses the installed desktop app-tools helper; it does not redistribute or patch the desktop app.

**Codex CLI:** OpenSwarm discovers loaded threads on a running shared local app-server daemon when its control socket is available. For an explicit connection on any supported platform, start a local server and connect the normal Codex terminal to it:

```sh
codex app-server --listen ws://127.0.0.1:4500
```

In another terminal:

```sh
codex --remote ws://127.0.0.1:4500
```

Register that existing server once:

```sh
openswarm connect --url ws://127.0.0.1:4500
openswarm doctor
```

This uses Codex's own terminal UI. OpenSwarm only sends messages to threads already loaded by that server. It never resumes a second runtime against an unrelated active session. An arbitrary CLI process with no reachable server is not automatically attachable.

### Plugin option

The self-contained plugin is at [`plugins/openswarm`](plugins/openswarm), with Claude and Codex manifests, one skill, a stdio MCP server, and an identity hook. No build step or npm dependencies are required inside the plugin.

For Claude Code:

```sh
claude plugin marketplace add rubinownz111/openswarm
claude plugin install openswarm@openswarm
```

For Codex, the CLI installer above is the tested setup path. Install **either** the plugin or the CLI integration in a provider to avoid duplicate tool registrations. Plugin installation alone retains Claude's existing inbound policy; choose `accept` in Claude's **Messages from your other sessions** setting for automatic delivery.

## Agent tools

| Tool                 | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `openswarm_whoami`   | Return the real session ID, or null when the host did not supply it |
| `openswarm_list`     | Find reachable peers and inspect provider health                    |
| `openswarm_send`     | Send `{ to, text, key, from? }`                                     |
| `openswarm_reply`    | Reply with `{ replyTo, text, from? }`; routing is automatic         |
| `openswarm_messages` | Read messages and delivery state, with pagination                   |

Only an addressed recipient can reply. MCP checks a supplied sender against the host identity when available. If identity is missing, the skill explains how to use the real ID from SessionStart or the incoming envelope.

CLI equivalents are available for existing sessions that have not loaded the MCP:

```sh
openswarm list
openswarm send --from claude:SESSION_UUID --to codex:THREAD_UUID --file message.txt --key review-request-1
openswarm reply MESSAGE_UUID --from codex:THREAD_UUID --file answer.txt
openswarm status MESSAGE_UUID
openswarm messages --session codex:THREAD_UUID
openswarm wait MESSAGE_UUID --seconds 30
```

Reuse a retry key only with identical content. `--file` keeps arbitrary message text out of shell interpolation. Replies with the same original message and text are deduplicated.

## Delivery guarantees

| State      | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `queued`   | Saved durably; waiting for a reachable recipient or a definite busy rejection           |
| `sending`  | Native submission is in progress                                                        |
| `accepted` | The native provider accepted the message; a reply separately confirms a response        |
| `failed`   | The provider explicitly rejected it                                                     |
| `unknown`  | A timeout, disconnect, or crash left submission uncertain; never automatically replayed |
| `expired`  | Still queued after 24 hours; no later surprise delivery                                 |

Messages are committed to SQLite before submission, ordered per recipient, and bounded to 500 pending messages. Other recipients can proceed independently. Simultaneous clients share one broker. History remains local and is paged with indexed queries.

There is no exactly-once transaction across SQLite and another application's inbox. OpenSwarm does not pretend otherwise: ambiguous submissions become `unknown`. Provider acceptance also does not guarantee that Claude's inbound policy allowed immediate delivery. See [delivery and recovery](docs/protocol.md).

## Scope and trust

One computer, one trusted OS user, existing agents. Linux, macOS, and Windows use the same Node implementation; transport tests run on all three in CI. Actual provider availability is reported by `openswarm doctor`.

The broker uses a Unix socket or Windows named pipe plus a private bearer token. It does not listen on a TCP port. State lives in `~/.openswarm`, separately from any Swarm installation. `OPENSWARM_HOME` selects another local state directory. All agents under the same OS account remain mutually trusted; sender labels are attribution, not an isolation boundary.

No full provider transcripts, model keys, or browser data are copied. Peer text and delivery receipts are private local history. OpenSwarm has no telemetry. Providers continue using their own accounts, policies, and networking.

OpenSwarm does not launch Claude sessions, change agents' tool permissions, manage projects, expose remote access, or orchestrate agents. Peer messages are context under each agent's existing instructions and do not grant user authorization.

## Operate and remove

```sh
openswarm doctor
openswarm stop
openswarm serve
```

`stop` stops only the messaging broker and its transport helpers. Existing Claude/Codex agents keep running. An installed MCP may restart the broker on its next heartbeat; disable/remove the integration first for a persistent stop.

For CLI installation, remove the provider entries with `claude mcp remove --scope user openswarm` and `codex mcp remove openswarm`. Remove only the `Connecting OpenSwarm` SessionStart hook and the `openswarm` skill folders. Restore your preferred `crossSessionInbound` value if you opted into `accept`. Provider settings backups are under `~/.openswarm/backups`. Then run `openswarm stop` and `npm uninstall -g @rubinownz111/openswarm`. Local message history remains until you deliberately remove it.

## Develop

```sh
npm ci
npm run check
```

The tests cover transport framing, authentication, concurrent startup, durable retries, recipient ordering, offline expiry, process-crash recovery, MCP behavior, and provider contracts without requiring model credentials. Live provider tests are separate: see [verification](docs/verification.md).

This project originated from the messaging feature of Swarm. The public repository contains only OpenSwarm's independently packaged messaging code, not the private app's UI, data, configuration, or Git history.
