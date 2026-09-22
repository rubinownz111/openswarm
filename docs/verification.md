# Verification

Automated checks require no provider accounts or secrets and run on Windows, Ubuntu, and macOS with Node 24. They exercise real OS local IPC and SQLite, including a forced daemon process crash and simultaneous startup. Provider mutations are simulated in these tests.

The release process additionally checks the installable npm archive, the Claude/Codex plugin manifests, and the skill. Public artifacts exclude runtime state, local experiments, credentials, and the private Swarm repository.

Live provider verification is recorded separately from CI. Development uses bounded echo/reply messages in dedicated test sessions. It does not send prompts into unrelated active work, alter existing agents' permissions, or copy provider transcripts into the repository.

## Live checks on September 22, 2026

- Windows, Claude Code 2.1.278: an existing Claude session received a message from a Codex desktop thread and sent its reply back through OpenSwarm into that same desktop thread.
- Windows, Codex CLI 0.155.1: a loaded thread on a local WebSocket app server received a message and replied through the OpenSwarm MCP. The test thread retained a read-only execution sandbox; only the messaging tools were explicitly approved.
- A fresh Claude background test session loaded the packaged plugin, obtained its own correct identity through the hook/MCP, discovered peers, and initiated a message into the Codex desktop thread. The test launch used the owner's requested permission mode; the plugin itself does not change it.
- The real Claude and Codex CLI installers were exercised twice against isolated configuration directories. MCP registrations and the identity hook remained idempotent, unrelated settings were preserved, and the explicit inbound/tool approval options were applied.

Live authenticated provider runs on Linux and macOS have not been performed in this Windows development environment. CI validates the portable broker, IPC, package and provider contracts on those operating systems; it does not certify their installed provider applications.

## Reproduce a live test

1. Install the integrations and open one Claude session and one reachable Codex session.
2. Run `openswarm doctor` and verify both transports are healthy.
3. Ask Codex to send a unique marker to the exact Claude ID through `openswarm_send`, requesting a reply via `openswarm_reply`.
4. Confirm the returned message has `replyTo` equal to the original ID and both receipts are accepted.
5. Repeat in the opposite direction. Reuse the original send key with identical content and confirm the original message ID is returned without another delivery.

Do not interpret a mocked provider test or a provider-accepted receipt as proof that the receiving model answered. Account policies, installed versions, and sandbox configuration remain part of each live environment.
