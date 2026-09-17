import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { assertInstalledProtocol, protocolSchemaAvailable } from "../src/codex.ts";

const root = join(import.meta.dirname, "..");
const src = join(root, "src");
const files: string[] = [];
const visit = (directory: string) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
};
visit(src);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--experimental-transform-types", "--check", file], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    process.exit(result.status ?? 1);
  }
}
if (!protocolSchemaAvailable()) throw new Error("generated App Server protocol snapshot is missing");
assertInstalledProtocol([
  "initialize",
  "thread/start",
  "turn/start",
  "turn/interrupt",
  "model/list",
  "account/read",
  "account/rateLimits/read",
  "command/exec",
]);
console.log("build ok: " + files.length + " TypeScript modules; installed protocol snapshot present");
