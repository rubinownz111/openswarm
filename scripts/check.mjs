import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const files = ["plugins", "test", "scripts"].flatMap(walk);
for (const file of files.filter((f) => f.endsWith(".mjs"))) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (result.status) process.exit(result.status);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const file of files.filter((f) => f.endsWith(".json"))) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (file.endsWith("plugin.json") && value.version !== pkg.version)
    throw new Error(`Version mismatch: ${file}`);
}
for (const file of files) {
  const body = readFileSync(file, "utf8");
  if (body.includes("[" + "TODO:"))
    throw new Error(`Unfinished scaffold: ${file}`);
  if (/(?:gh[pousr]_|sk-(?:proj-)?)[a-zA-Z0-9_-]{24,}/.test(body))
    throw new Error(`Possible credential in source: ${file}`);
}
console.log(`Checked ${files.length} source, test, and plugin files.`);
