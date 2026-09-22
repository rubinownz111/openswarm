import { serve } from "../../plugins/openswarm/lib/service.mjs";
import { DeliveryError } from "../../plugins/openswarm/lib/rpc.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";

await serve({
  providersFactory: () => ({
    sessions: [
      "claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ].map((id) => ({ id, title: id, provider: id.split(":")[0] })),
    health: { fixture: { ok: true } },
    async discover() {
      return this.publicSessions();
    },
    publicSessions() {
      return this.sessions;
    },
    async send(target, message) {
      appendFileSync(
        path.join(process.env.OPENSWARM_HOME, "attempts.txt"),
        target.id + "\n",
      );
      if (message.includes("BLOCK_DELIVERY")) await delay(60000);
      if (message.includes("TIMEOUT_DELIVERY"))
        throw new DeliveryError("Fixture disconnected after submission");
      return { accepted: true };
    },
    close() {},
  }),
});
