import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "../plugins/openswarm/lib/service.mjs";
import { after } from "node:test";

export const A = "claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const B = "codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const C = "codex:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const directories = [];
after(async () => {
  for (const dir of directories) {
    const resolved = path.resolve(dir);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith("openswarm test ")
    )
      throw new Error("Unsafe test cleanup path");
    await rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});
export function temp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "openswarm test "));
  directories.push(dir);
  return dir;
}
export function envFor(dir) {
  const env = {
    ...process.env,
    OPENSWARM_HOME: dir,
    OPENSWARM_CLAUDE: "openswarm-missing-claude",
    OPENSWARM_CODEX: "openswarm-missing-codex",
  };
  for (const key of [
    "CODEX_THREAD_ID",
    "CODEX_APP_TOOLS_PIPE_PATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "OPENSWARM_SESSION_ID",
    "OPENSWARM_PROVIDER",
  ])
    delete env[key];
  return env;
}
export async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await delay(40);
  }
  throw last || new Error("Condition not reached");
}
export async function daemon(t, dir) {
  const file = fileURLToPath(new URL("./fixtures/daemon.mjs", import.meta.url));
  const child = spawn(process.execPath, [file], {
    env: envFor(dir),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await request("stop", {}, { dir, timeout: 1000 });
      } catch {
        child.kill();
      }
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
      ).catch(() => child.kill());
    }
  });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    return request("ping", {}, { dir, timeout: 300 });
  });
  return child;
}
