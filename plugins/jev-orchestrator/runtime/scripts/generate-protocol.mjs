import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const out = mkdtempSync(join(tmpdir(), "codex-orchestrator-protocol-"));
try {
  const command = process.platform === "win32" ? "codex.exe" : "codex";
  const result = spawnSync(
    command,
    ["app-server", "generate-json-schema", "--experimental", "--out", out],
    { stdio: "inherit", shell: false },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  cpSync(
    join(out, "codex_app_server_protocol.v2.schemas.json"),
    join(import.meta.dirname, "..", "protocol", "codex-app-server.v2.schemas.json"),
  );
  console.log("refreshed protocol/codex-app-server.v2.schemas.json");
} finally {
  rmSync(out, { recursive: true, force: true });
}
