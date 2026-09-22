import { mkdtempSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "openswarm package "));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run with npm run package:check");
const run = (args) =>
  execFileSync(process.execPath, [npm, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
  });
try {
  const [archive] = JSON.parse(
    run(["pack", "--json", "--pack-destination", dir]),
  );
  for (const file of archive.files) {
    assert.ok(
      !/(^|\/)(\.local|\.openswarm|\.swarm|node_modules)(\/|$)/.test(file.path),
    );
    assert.ok(!/\.(sqlite|log|pem)$|runtime\.json$/.test(file.path));
  }
  const prefix = path.join(dir, "install");
  run([
    "install",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    path.join(dir, archive.filename),
  ]);
  const installed = path.join(
    prefix,
    "node_modules",
    "@rubinownz111",
    "openswarm",
  );
  const cli = path.join(
    installed,
    "plugins",
    "openswarm",
    "bin",
    "openswarm.mjs",
  );
  const output = execFileSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(JSON.parse(output).version, archive.version);
  assert.ok(
    existsSync(path.join(installed, "plugins", "openswarm", ".mcp.json")),
  );
  assert.ok(
    existsSync(
      path.join(
        installed,
        "plugins",
        "openswarm",
        ".codex-plugin",
        "plugin.json",
      ),
    ),
  );
  assert.ok(
    existsSync(
      path.join(
        installed,
        "plugins",
        "openswarm",
        ".claude-plugin",
        "plugin.json",
      ),
    ),
  );
  assert.ok(existsSync(path.join(installed, "LICENSE")));
  console.log(
    `Installed and ran ${archive.filename}: ${archive.entryCount} files, ${archive.size} bytes compressed, no runtime dependencies.`,
  );
} finally {
  const resolved = path.resolve(dir);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("openswarm package ")
  )
    throw new Error("Unsafe cleanup path");
  await rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
