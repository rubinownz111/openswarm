import {
  mkdirSync,
  chmodSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export const VERSION = "0.1.0";
export const PROTOCOL = 1;
export const CLI = fileURLToPath(
  new URL("../bin/openswarm.mjs", import.meta.url),
);
export const PLUGIN = fileURLToPath(new URL("../", import.meta.url));
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const SESSION =
  /^(claude|codex):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function stateDir(env = process.env) {
  return path.resolve(env.OPENSWARM_HOME || path.join(homedir(), ".openswarm"));
}
export function endpoint(dir) {
  const hash = createHash("sha256")
    .update(path.resolve(dir))
    .digest("hex")
    .slice(0, 24);
  // macOS's per-user TMPDIR can exceed sockaddr_un's 104-byte path limit.
  const socketDir = Buffer.byteLength(tmpdir()) > 35 ? "/tmp" : tmpdir();
  return process.platform === "win32"
    ? `\\\\.\\pipe\\openswarm-${hash}`
    : path.join(socketDir, `openswarm-${process.getuid()}-${hash}.sock`);
}
export function privateDir(dir) {
  let created = false;
  try {
    mkdirSync(dir, { mode: 0o700 });
    created = true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("OpenSwarm state must be a real private directory");
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid())
      throw new Error("OpenSwarm state belongs to another user");
    chmodSync(dir, 0o700);
  } else if (created) {
    const account = `${process.env.USERDOMAIN}\\${userInfo().username}`;
    execFileSync(
      path.join(process.env.SystemRoot, "System32", "icacls.exe"),
      [
        dir,
        "/inheritance:r",
        "/grant:r",
        `${account}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ],
      { windowsHide: true, stdio: "pipe" },
    );
  }
}
export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, file);
}
export function identity(env = process.env) {
  if (SESSION.test(env.OPENSWARM_SESSION_ID || ""))
    return env.OPENSWARM_SESSION_ID;
  // Claude may have been launched by Codex; never inherit its parent's identity.
  if (env.CLAUDE_CODE_MESSAGING_SOCKET || env.OPENSWARM_PROVIDER === "claude")
    return null;
  return UUID.test(env.CODEX_THREAD_ID || "")
    ? `codex:${env.CODEX_THREAD_ID}`
    : null;
}
export function assertObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value;
}
export function text(value, name, max) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error(`${name} must contain 1–${max} characters without NUL`);
  return value;
}
