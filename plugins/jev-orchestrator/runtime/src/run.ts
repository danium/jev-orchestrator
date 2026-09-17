import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  hashJson,
  ensureDir,
  redactSecrets,
  readJson,
  writeJsonAtomic,
  type ExecutionProfile,
  type Plan,
  type TaskInput,
} from "./contracts.ts";
import {
  acquireWorkspaceLock,
  artifactFingerprint,
  freezeVerification,
  inspectGit,
  requireCleanWorkspace,
  reviewManifest,
  runVerificationChecks,
  type CheckResult,
  type CommandRunner,
  type GitInspection,
  type ProjectVerification,
} from "./workspace.ts";
import { appendJournal, readJournal, type JournalEvent } from "./journal.ts";

export type RunState =
  | "created"
  | "preflight"
  | "awaiting_route_confirmation"
  | "running"
  | "verifying"
  | "awaiting_review"
  | "accepted"
  | "rejected"
  | "repair_pending"
  | "blocked"
  | "interrupted"
  | "failed"
  | "abandoned";

export type WorkerAttemptInput = {
  task: TaskInput;
  profile: ExecutionProfile;
  repo: string;
  attempt: number;
  prompt: string;
};

export type WorkerAttemptResult = {
  ok: boolean;
  retryable: boolean;
  category: "completed" | "environment" | "missing-requirement" | "authentication" | "transport-unknown" | "cancelled" | "failed";
  actualModelId: string | null;
  actualEffort: string | null;
  detail: string;
};

export type Worker = {
  run(input: WorkerAttemptInput): Promise<WorkerAttemptResult>;
  interrupt?(): Promise<void>;
};

export type VerificationRecord = {
  hash: string;
  artifactFingerprint: string;
  strength: "strong" | "limited" | "failed";
  checks: CheckResult[];
};

export type RunRecord = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  state: RunState;
  task: TaskInput;
  plan: Plan;
  repository: {
    path: string;
    baseFingerprint: string;
    currentFingerprint: string | null;
  };
  attempts: Array<{
    number: number;
    at: string;
    requestedProfileId: string;
    actualModelId: string | null;
    actualEffort: string | null;
    category: WorkerAttemptResult["category"];
    ok: boolean;
    detail: string;
  }>;
  verification: VerificationRecord | null;
  humanOutcome: { kind: "accepted" | "rejected"; at: string; reason?: string } | null;
  failure: { category: string; detail: string } | null;
  typesafeUsage: Record<string, unknown> | null;
  quotaObservation: unknown;
};

export type RunStoreOptions = {
  home: string;
  commandRunner?: CommandRunner;
  now?: () => string;
};

const nowIso = () => new Date().toISOString();

const safeId = (value: string): string => {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) throw new Error("run id contains unsafe path characters");
  return value;
};

export class RunStore {
  readonly runsPath: string;
  readonly locksPath: string;
  private readonly commandRunner?: CommandRunner;
  private readonly now: () => string;

  constructor(options: RunStoreOptions) {
    this.runsPath = join(options.home, "runs");
    this.locksPath = join(options.home, "locks");
    this.commandRunner = options.commandRunner;
    this.now = options.now ?? nowIso;
    ensureDir(this.runsPath);
    ensureDir(this.locksPath);
  }

  private dir(id: string): string {
    return join(this.runsPath, safeId(id));
  }

  private resultPath(id: string): string {
    return join(this.dir(id), "result.json");
  }

  private eventPath(id: string): string {
    return join(this.dir(id), "events.jsonl");
  }

  private save(record: RunRecord): void {
    record.updatedAt = this.now();
    writeJsonAtomic(this.resultPath(record.id), record);
  }

  private event(record: RunRecord, type: string, detail: Record<string, unknown> = {}): void {
    appendJournal(this.eventPath(record.id), {
      at: this.now(),
      type,
      state: record.state,
      detail,
    });
  }

  create(
    id: string,
    task: TaskInput,
    plan: Plan,
    repoInspection: GitInspection,
    baseFingerprint: string,
    quotaObservation: unknown = null,
  ): RunRecord {
    safeId(id);
    if (existsSync(this.resultPath(id))) throw new Error("run already exists: " + id);
    requireCleanWorkspace(repoInspection);
    if (plan.status !== "confirmed") throw new Error("run requires an explicitly confirmed route");
    if (plan.repository.path !== repoInspection.path) {
      throw new Error("plan repository does not match the inspected checkout");
    }
    const profileId = plan.profileId;
    if (!profileId) throw new Error("confirmed plan has no profile");
    const record: RunRecord = {
      schemaVersion: 1,
      id,
      createdAt: this.now(),
      updatedAt: this.now(),
      state: "created",
      task,
      plan,
      repository: {
        path: repoInspection.path,
        baseFingerprint,
        currentFingerprint: null,
      },
      attempts: [],
      verification: null,
      humanOutcome: null,
      failure: null,
      typesafeUsage: plan.typesafe.usage,
      quotaObservation,
    };
    ensureDir(this.dir(id));
    writeJsonAtomic(join(this.dir(id), "task.json"), task);
    writeJsonAtomic(join(this.dir(id), "plan.json"), plan);
    writeJsonAtomic(this.resultPath(id), record);
    this.event(record, "created", { baseFingerprint });
    return record;
  }

  load(id: string): RunRecord {
    const record = readJson<RunRecord>(this.resultPath(id));
    if (record.schemaVersion !== 1) throw new Error("unsupported run record schema");
    return record;
  }

  events(id: string): JournalEvent[] {
    return readJournal(this.eventPath(id));
  }

  status(id: string): RunRecord {
    return this.load(id);
  }

  private profile(record: RunRecord): ExecutionProfile {
    const id = record.plan.profileId;
    if (!id) throw new Error("run plan has no profile");
    return {
      id,
      enabled: true,
      modelId: record.plan.requested.modelId ?? "",
      effort: record.plan.requested.effort
        ? { kind: "explicit", value: record.plan.requested.effort }
        : { kind: "model-default" },
      speed: "standard",
      permissionClass: record.plan.requested.permissionClass ?? "implement",
      riskClasses: [record.task.knownRisk],
      fits: "confirmed route",
      status: "qualified",
      quotaBindingId: null,
    };
  }

  private prompt(record: RunRecord): string {
    const safeTask = {
      objective: redactSecrets(record.task.objective).text,
      acceptanceCriteria: record.task.acceptanceCriteria.map((item) => redactSecrets(item).text),
      scopeHints: record.task.scopeHints.map((item) => redactSecrets(item).text),
      requiredAccess: record.task.requiredAccess,
      knownRisk: record.task.knownRisk,
    };
    return JSON.stringify({
      instruction: "Perform only this bounded task in the approved checkout. Do not change routing, permissions, checks, or spending policy.",
      task: safeTask,
    });
  }

  async execute(
    id: string,
    project: ProjectVerification,
    worker: Worker,
  ): Promise<RunRecord> {
    const record = this.load(id);
    if (!["created", "repair_pending", "interrupted"].includes(record.state)) {
      throw new Error("run is not executable from state " + record.state);
    }
    const inspection = await inspectGit(record.repository.path, this.commandRunner);
    const current = artifactFingerprint(inspection.path, inspection);
    const expected = record.repository.currentFingerprint ?? record.repository.baseFingerprint;
    if (record.state !== "created" && current !== expected) {
      record.state = "blocked";
      record.failure = {
        category: "workspace_changed",
        detail: "workspace fingerprint changed before resume; review and recover explicitly",
      };
      this.event(record, "blocked", record.failure);
      this.save(record);
      return record;
    }
    const lock = acquireWorkspaceLock(join(this.locksPath, hashJson(record.repository.path) + ".lock"));
    try {
      const lockedInspection = await inspectGit(record.repository.path, this.commandRunner);
      const lockedFingerprint = artifactFingerprint(lockedInspection.path, lockedInspection);
      if (lockedFingerprint !== expected) {
        record.state = "blocked";
        record.failure = {
          category: "workspace_changed",
          detail: "workspace changed while acquiring the writer lock; review and recover explicitly",
        };
        this.event(record, "blocked", record.failure);
        this.save(record);
        return record;
      }
      const frozen = freezeVerification(project);
      record.state = "preflight";
      record.plan.verificationPlanHash = frozen.hash;
      this.event(record, "preflight", { verificationPlanHash: frozen.hash });
      this.save(record);
      const maxAttempts = record.plan.maximumAttempts;
      while (record.attempts.length < maxAttempts) {
        const attempt = record.attempts.length + 1;
        record.state = "running";
        this.event(record, "worker-start", { attempt });
        this.save(record);
        let result: WorkerAttemptResult;
        try {
          result = await worker.run({
            task: record.task,
            profile: this.profile(record),
            repo: record.repository.path,
            attempt,
            prompt: this.prompt(record),
          });
        } catch (error) {
          result = {
            ok: false,
            retryable: false,
            category: "failed",
            actualModelId: null,
            actualEffort: null,
            detail: redactSecrets(String(error)).text,
          };
        }
        record.attempts.push({
          number: attempt,
          at: this.now(),
          requestedProfileId: record.plan.profileId ?? "",
          actualModelId: result.actualModelId,
          actualEffort: result.actualEffort,
          category: result.category,
          ok: result.ok,
          detail: result.detail,
        });
        this.event(record, result.ok ? "worker-completed" : "worker-failed", {
          attempt,
          category: result.category,
          actualModelId: result.actualModelId,
          actualEffort: result.actualEffort,
        });
        if (!result.ok) {
          if (result.retryable && record.attempts.length < maxAttempts) {
            record.state = "repair_pending";
            record.failure = { category: result.category, detail: result.detail };
            this.event(record, "repair-pending", record.failure);
            this.save(record);
            continue;
          }
          record.state = result.category === "cancelled" ? "interrupted" : "failed";
          record.failure = { category: result.category, detail: result.detail };
          this.event(record, "terminal-failure", record.failure);
          this.save(record);
          return record;
        }
        const after = await inspectGit(record.repository.path, this.commandRunner);
        record.repository.currentFingerprint = artifactFingerprint(after.path, after);
        record.state = "verifying";
        this.event(record, "verification-start", { attempt });
        this.save(record);
        const verification = await runVerificationChecks(project, record.repository.path, this.commandRunner);
        record.verification = {
          hash: frozen.hash,
          artifactFingerprint: record.repository.currentFingerprint,
          strength: verification.strength,
          checks: verification.checks,
        };
        if (verification.strength === "failed") {
          record.failure = {
            category: "verification_failed",
            detail: "approved verification checks failed; the diff remains on disk",
          };
          if (record.attempts.length < maxAttempts) {
            record.state = "repair_pending";
            this.event(record, "repair-pending", record.failure);
            this.save(record);
            return record;
          }
          record.state = "failed";
          this.event(record, "verification-failed", record.failure);
          this.save(record);
          return record;
        }
        record.state = "awaiting_review";
        record.failure = null;
        this.event(record, "awaiting-review", {
          artifactFingerprint: record.repository.currentFingerprint,
          verificationStrength: verification.strength,
        });
        this.save(record);
        return record;
      }
      record.state = "failed";
      record.failure = { category: "attempt_budget_exhausted", detail: "worker attempt budget exhausted" };
      this.event(record, "attempt-budget-exhausted", record.failure);
      this.save(record);
      return record;
    } finally {
      lock.release();
    }
  }

  async accept(id: string): Promise<RunRecord> {
    const record = this.load(id);
    if (record.state !== "awaiting_review" || !record.verification) {
      throw new Error("run is not awaiting review");
    }
    const inspection = await inspectGit(record.repository.path, this.commandRunner);
    const fingerprint = artifactFingerprint(inspection.path, inspection);
    if (fingerprint !== record.verification.artifactFingerprint) {
      record.state = "blocked";
      record.failure = { category: "artifact_changed", detail: "artifact changed after verification; acceptance is invalid" };
      this.event(record, "blocked", record.failure);
      this.save(record);
      return record;
    }
    record.state = "accepted";
    record.humanOutcome = { kind: "accepted", at: this.now() };
    this.event(record, "accepted", { artifactFingerprint: fingerprint });
    this.save(record);
    return record;
  }

  async reject(id: string, reason: string): Promise<RunRecord> {
    if (!reason.trim()) throw new Error("rejection reason is required");
    const record = this.load(id);
    if (record.state !== "awaiting_review") throw new Error("run is not awaiting review");
    record.state = "rejected";
    record.humanOutcome = { kind: "rejected", at: this.now(), reason: redactSecrets(reason).text };
    this.event(record, "rejected", { reason: record.humanOutcome.reason });
    this.save(record);
    return record;
  }

  list(): RunRecord[] {
    if (!existsSync(this.runsPath)) return [];
    return readdirSync(this.runsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(this.runsPath, entry.name, "result.json")))
      .map((entry) => this.load(entry.name));
  }
}

export const fakeWorker = (
  fn: (input: WorkerAttemptInput) => Promise<WorkerAttemptResult>,
): Worker => ({ run: fn });
