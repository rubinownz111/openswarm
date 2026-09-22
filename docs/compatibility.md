# Provider compatibility

OpenSwarm's broker, CLI, MCP server, persistence, and tests run on Node.js 24.13+ on Windows, Linux, and macOS. Native delivery additionally requires the corresponding provider interface. A green broker test is not a claim that every provider build was live-tested on that operating system.

| Provider connection       | Discovery                                         | Automatic native delivery                                 | Requirements                                                             |
| ------------------------- | ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Claude Code               | `claude agents --json`                            | Native `ListAgents` / `SendMessage` MCP tools             | Cross-session messaging enabled; an inbound policy that permits delivery |
| Codex desktop             | Installed desktop app-tools helper                | `send_message_to_thread` on the actual desktop connection | Desktop app, bundled app-tools, current thread registration              |
| Codex shared daemon       | `codex app-server proxy` and `thread/loaded/list` | `turn/start` on that same server                          | Running, reachable local control socket and compatible CLI               |
| Codex explicit app server | Local WebSocket and `thread/loaded/list`          | `turn/start` on that same server                          | `codex app-server --listen ws://127.0.0.1:PORT`; registered endpoint     |

OpenSwarm does not infer a running thread from a transcript file, inject keystrokes, or resume a parallel runtime to force delivery. Unsupported connections appear in `doctor` with a reason. The explicit local app-server route is the portable option when the shared daemon or desktop integration is unavailable.

The desktop helper is a version-dependent installed interface, not a public compatibility promise. The Codex app-server WebSocket interface is documented as experimental. Pin working provider versions in environments that require repeatability, and run `doctor` after upgrades.

Development live checks used Claude Code **2.1.278** and Codex CLI **0.155.1** on Windows. Other releases may work if they expose the same interfaces; no invented minimum version is enforced. The executable resolver supports native installs and Windows npm installs. Set `OPENSWARM_CLAUDE` or `OPENSWARM_CODEX` to an explicit executable path if needed. No shell is used to launch provider helpers.

## Boundaries

- Windows-native sessions and sessions inside WSL are separate environments. Install and run OpenSwarm inside each environment; this release does not bridge them or separate PCs.
- Codex desktop discovery includes pinned threads and up to 50 recent entries. App-server discovery pages loaded threads up to 1,000. These are not every archived conversation.
- Claude may hold or refuse a message according to its own settings. Opt into `crossSessionInbound: accept` for automatic receipt. OpenSwarm does not override managed policies.
- Provider tools may still require permission for actions requested by a message. Transport setup is separate from tool execution permissions.
- A disconnected or asleep computer cannot deliver. Queued messages expire after 24 hours; unknown deliveries never automatically retry.
- A new MCP configuration requires a new/reloaded provider session. Existing sessions can use the CLI immediately.

## References

- [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging): local sockets, native Windows pipes, incoming-message policy, and delivery behavior.
- [Claude plugins reference](https://code.claude.com/docs/en/plugins-reference): packaging MCP and identity hooks.
- [Codex app server](https://learn.chatgpt.com/docs/app-server): loaded threads, `turn/start`, WebSocket transport, and native terminal attachment.
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): stdio tool integration.

The installed CLI help and schemas are also checked when developing an adapter; documentation does not substitute for a live round trip.
