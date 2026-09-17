import { createHash } from "node:crypto";
import { openSync, closeSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import { redactSecrets, sha256, type TaskInput } from "./contracts.ts";

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CommandResult>;

export const runStructuredCommand: CommandRunner = async (command, args, cwd, timeoutMs) => {
  const child = spawn(command, args, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const closed = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    return { code: await closed, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

export type GitInspection = {
  path: string;
  identity: string | null;
  revision: string | null;
  clean: boolean;
  entries: string[];
  stderr: string[];
};

const git = async (
  args: string[],
  repo: string,
  runner: CommandRunner = runStructuredCommand,
): Promise<CommandResult> => runner("git", args, repo, 15000);

export const inspectGit = async (
  inputPath: string,
  runner: CommandRunner = runStructuredCommand,
): Promise<GitInspection> => {
  const path = resolve(inputPath);
  const rootResult = await git(["rev-parse", "--show-toplevel"], path, runner);
  const canonical = rootResult.code === 0 ? resolve(rootResult.stdout.trim()) : path;
  const revisionResult = await git(["rev-parse", "HEAD"], canonical, runner);
  const statusResult = await git(["status", "--porcelain=v1", "--untracked-files=all"], canonical, runner);
  const entries = statusResult.code === 0
    ? statusResult.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
    : ["git-status-unavailable"];
  return {
    path: canonical,
    identity: rootResult.code === 0 ? canonical.toLowerCase() : null,
    revision: revisionResult.code === 0 ? revisionResult.stdout.trim() : null,
    clean: statusResult.code === 0 && entries.length === 0,
    entries,
    stderr: [rootResult.stderr, revisionResult.stderr, statusResult.stderr]
      .filter(Boolean)
      .map((message) => redactSecrets(message).text.slice(0, 1000)),
  };
};

const readTree = (root: string, current = root, output: string[] = []): string[] => {
  if (!existsSync(current)) return output;
  for (const name of readdirSync(current)) {
    if (name === ".git") continue;
    const path = join(current, name);
    const stat = statSync(path);
    if (stat.isDirectory()) readTree(root, path, output);
    else output.push(path);
  }
  return output;
};

export const artifactFingerprint = (
  repo: string,
  inspection: GitInspection,
  fileReader: (path: string) => Buffer = (path) => readFileSync(path),
): string => {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ revision: inspection.revision, entries: inspection.entries }));
  for (const path of readTree(repo).sort()) {
    hash.update("\n" + relative(repo, path));
    hash.update(fileReader(path));
  }
  return hash.digest("hex");
};

export const requireCleanWorkspace = (inspection: GitInspection): void => {
  if (!inspection.clean) {
    throw new Error(
      "worker checkout is dirty; checkpoint the source changes or choose a dedicated clean worktree: " +
        inspection.entries.join(", "),
    );
  }
};

export type WorkspaceLock = {
  path: string;
  token: string;
  release(): void;
};

export const acquireWorkspaceLock = (
  lockPath: string,
  holder = { pid: process.pid, startedAt: new Date().toISOString() },
): WorkspaceLock => {
  const token = sha256(lockPath + ":" + holder.pid + ":" + holder.startedAt + ":" + Math.random());
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    throw new Error(
      "workspace lock is held; inspect " +
        lockPath +
        " and recover explicitly rather than deleting a possibly live lock (" +
        String(error) +
        ")",
    );
  }
  writeFileSync(lockPath, JSON.stringify({ token, ...holder }) + "\n", "utf8");
  closeSync(fd);
  return {
    path: lockPath,
    token,
    release() {
      if (!existsSync(lockPath)) return;
      try {
        const current = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
        if (current.token === token) unlinkSync(lockPath);
      } catch {
        // A corrupt lock is retained for explicit recovery.
      }
    },
  };
};

export type CheckSpec = {
  id: string;
  command: string;
  args: string[];
  timeoutMs: number;
  requiredExitCode: number;
};

export type ProjectVerification = {
  schemaVersion: 1;
  mode: "sandboxed" | "manual-only" | "unconfigured";
  checks: CheckSpec[];
};

export const freezeVerification = (project: ProjectVerification): {
  project: ProjectVerification;
  hash: string;
} => {
  if (project.schemaVersion !== 1) throw new Error("project verification schemaVersion must be 1");
  if (!["sandboxed", "manual-only", "unconfigured"].includes(project.mode)) {
    throw new Error("project verification mode is invalid");
  }
  for (const check of project.checks) {
    if (!check.id || !check.command || !Array.isArray(check.args) || check.args.some((arg) => typeof arg !== "string")) {
      throw new Error("verification checks must use command and argument arrays");
    }
    if (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || !Number.isInteger(check.requiredExitCode)) {
      throw new Error("verification check timeout/exit code is invalid");
    }
  }
  const frozen = JSON.parse(JSON.stringify(project)) as ProjectVerification;
  return { project: frozen, hash: sha256(JSON.stringify(frozen)) };
};

export type CheckResult = {
  id: string;
  command: string[];
  code: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export const runVerificationChecks = async (
  project: ProjectVerification,
  repo: string,
  runner: CommandRunner = runStructuredCommand,
): Promise<{ strength: "strong" | "limited" | "failed"; checks: CheckResult[] }> => {
  if (project.mode === "unconfigured" || project.checks.length === 0) {
    return { strength: "limited", checks: [] };
  }
  if (project.mode === "manual-only") return { strength: "limited", checks: [] };
  const checks: CheckResult[] = [];
  for (const check of project.checks) {
    const result = await runner(check.command, check.args, repo, check.timeoutMs);
    const redactedStdout = redactSecrets(result.stdout).text.slice(-20000);
    const redactedStderr = redactSecrets(result.stderr).text.slice(-20000);
    const passed = result.code === check.requiredExitCode;
    checks.push({
      id: check.id,
      command: [check.command, ...check.args],
      code: result.code,
      passed,
      stdout: redactedStdout,
      stderr: redactedStderr,
      timedOut: result.code === null,
    });
    if (!passed) return { strength: "failed", checks };
  }
  return { strength: "strong", checks };
};

export type OwnedProcess = {
  pid: number;
  kill(): Promise<"stopped" | "unknown">;
};

export const ownProcess = (
  child: ChildProcess,
  waitMs = 5000,
): OwnedProcess => ({
  pid: child.pid ?? -1,
  async kill() {
    if (!child.pid || child.exitCode !== null) return "stopped";
    child.kill();
    const result = await Promise.race([
      new Promise<"stopped">((resolveStopped) => child.once("close", () => resolveStopped("stopped"))),
      new Promise<"unknown">((resolveUnknown) => setTimeout(() => resolveUnknown("unknown"), waitMs)),
    ]);
    return result;
  },
});

export const reviewManifest = async (
  repo: string,
  runner: CommandRunner = runStructuredCommand,
): Promise<{ inspection: GitInspection; fingerprint: string; files: string[] }> => {
  const inspection = await inspectGit(repo, runner);
  const files = readTree(inspection.path).map((path) => relative(inspection.path, path)).sort();
  return {
    inspection,
    fingerprint: artifactFingerprint(inspection.path, inspection),
    files,
  };
};

export const taskScopeFingerprint = (task: TaskInput): string =>
  sha256(JSON.stringify({ id: task.id, objective: task.objective, scopeHints: task.scopeHints }));
