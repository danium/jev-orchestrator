import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type RiskClass = "low" | "material" | "critical";
export type PermissionClass = "review" | "implement";
export type RequiredAccess = "read" | "write";
export type ProfileStatus = "candidate" | "qualified";
export type AuthProvider = "chatgpt" | "api" | "bedrock" | "unknown";

export type Effort =
  | { kind: "explicit"; value: string }
  | { kind: "model-default" };

export type ExecutionProfile = {
  id: string;
  enabled: boolean;
  modelId: string;
  effort: Effort;
  speed: "standard";
  permissionClass: PermissionClass;
  riskClasses: RiskClass[];
  fits: string;
  status: ProfileStatus;
  quotaBindingId: string | null;
};

export type QuotaBinding = {
  id: string;
  poolIds: string[];
  modelIds?: string[];
  evidence: "installed-account" | "user-approved" | "unknown";
  note: string;
};

export type RoutingConfig = {
  provider: "typesafe";
  model: string;
  maxTotalAttempts: number;
  totalDeadlineMs: number;
  confirmEveryRoute: true;
};

export type RunPolicy = {
  maxWorkerAttempts: number;
  activeWorkDeadlineMs: number;
  quotaFreshnessTargetMs: number;
  reservePercentagePoints: number;
  automaticEscalation: false;
};

export type AppConfig = {
  schemaVersion: 1;
  routing: RoutingConfig;
  runPolicy: RunPolicy;
  profiles: ExecutionProfile[];
  quotaBindings: QuotaBinding[];
};

export type TaskInput = {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  scopeHints: string[];
  requiredAccess: RequiredAccess;
  knownRisk: RiskClass;
  verificationAvailability: "meaningful" | "manual-only" | "unknown";
  modalities?: string[];
};

export type ModelCapability = {
  id: string;
  model?: string;
  supportedReasoningEfforts: string[];
  inputModalities?: string[];
  serviceTiers?: string[];
  defaultReasoningEffort?: string;
};

export type AuthSnapshot = {
  provider: AuthProvider;
  authenticated: boolean;
  managedLogin: boolean;
  accountId: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean | null;
  observedAt: string;
};

export type Plan = {
  schemaVersion: 1;
  taskId: string;
  profileId: string | null;
  requested: {
    modelId: string | null;
    effort: string | null;
    speed: "standard" | null;
    permissionClass: PermissionClass | null;
  };
  eligibilityReasons: string[];
  quotaBindingEvidence: string[];
  policyHash: string;
  repository: {
    path: string;
    identity: string | null;
    baseRevision: string | null;
  };
  verificationPlanHash: string | null;
  knownLimitations: string[];
  maximumAttempts: number;
  status:
    | "manual-preview"
    | "awaiting-route-confirmation"
    | "confirmed"
    | "deferred"
    | "blocked";
  routeSource: "offline" | "typesafe" | "manual";
  confidence: number | null;
  probabilities: Record<string, number> | null;
  typesafe: {
    model: string | null;
    responseVersion: string | null;
    usage: Record<string, unknown> | null;
  };
};

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  routing: {
    provider: "typesafe",
    model: "jev-1.13.0",
    maxTotalAttempts: 2,
    totalDeadlineMs: 15000,
    confirmEveryRoute: true,
  },
  runPolicy: {
    maxWorkerAttempts: 2,
    activeWorkDeadlineMs: 1200000,
    quotaFreshnessTargetMs: 30000,
    reservePercentagePoints: 5,
    automaticEscalation: false,
  },
  profiles: [
    {
      id: "luna-low-implement",
      enabled: false,
      modelId: "gpt-5.6-luna",
      effort: { kind: "explicit", value: "low" },
      speed: "standard",
      permissionClass: "implement",
      riskClasses: ["low"],
      fits: "Narrow semantic changes with explicit scope and reliable checks. Not ambiguous investigation or critical-invariant changes.",
      status: "candidate",
      quotaBindingId: null,
    },
    {
      id: "terra-medium-implement",
      enabled: false,
      modelId: "gpt-5.6-terra",
      effort: { kind: "explicit", value: "medium" },
      speed: "standard",
      permissionClass: "implement",
      riskClasses: ["low", "material"],
      fits: "Bounded implementation following established project patterns and clear acceptance criteria. Not an unbounded diagnosis with weak verification.",
      status: "candidate",
      quotaBindingId: null,
    },
    {
      id: "sol-medium-implement",
      enabled: false,
      modelId: "gpt-5.6-sol",
      effort: { kind: "explicit", value: "medium" },
      speed: "standard",
      permissionClass: "implement",
      riskClasses: ["low", "material", "critical"],
      fits: "Complex but bounded implementation where this route meets the required quality. Critical work still requires human approvals and checks.",
      status: "candidate",
      quotaBindingId: null,
    },
    {
      id: "astra-medium-implement",
      enabled: false,
      modelId: "gpt-6-astra",
      effort: { kind: "explicit", value: "medium" },
      speed: "standard",
      permissionClass: "implement",
      riskClasses: ["low", "material", "critical"],
      fits: "Difficult or unfamiliar reasoning when a stronger worker is justified. Not a default for mechanically specified edits.",
      status: "candidate",
      quotaBindingId: null,
    },
    {
      id: "astra-medium-review",
      enabled: false,
      modelId: "gpt-6-astra",
      effort: { kind: "explicit", value: "medium" },
      speed: "standard",
      permissionClass: "review",
      riskClasses: ["low", "material", "critical"],
      fits: "Read-only analysis or review requiring strong judgment. Cannot perform a task that requires file changes.",
      status: "candidate",
      quotaBindingId: null,
    },
    {
      id: "spark-default-implement",
      enabled: false,
      modelId: "gpt-5.3-codex-spark",
      effort: { kind: "model-default" },
      speed: "standard",
      permissionClass: "implement",
      riskClasses: ["low"],
      fits: "Candidate for bounded, well-specified work after local validation. A separate allowance is not evidence that an ambiguous task is suitable.",
      status: "candidate",
      quotaBindingId: null,
    },
  ],
  quotaBindings: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const fail = (message: string): never => {
  throw new Error(message);
};

export const validateConfig = (value: unknown): AppConfig => {
  if (!isRecord(value) || value.schemaVersion !== 1) fail("config schemaVersion must be 1");
  const routing = value.routing;
  const runPolicy = value.runPolicy;
  if (!isRecord(routing) || routing.provider !== "typesafe" || !nonEmpty(routing.model)) {
    fail("config routing must use the Typesafe provider and a model");
  }
  if (
    !Number.isInteger(routing.maxTotalAttempts) ||
    routing.maxTotalAttempts < 1 ||
    routing.maxTotalAttempts > 2 ||
    !Number.isInteger(routing.totalDeadlineMs) ||
    routing.totalDeadlineMs < 1 ||
    routing.confirmEveryRoute !== true
  ) {
    fail("config routing retry and confirmation policy is invalid");
  }
  if (
    !isRecord(runPolicy) ||
    runPolicy.automaticEscalation !== false ||
    !Number.isInteger(runPolicy.maxWorkerAttempts) ||
    runPolicy.maxWorkerAttempts < 1 ||
    runPolicy.maxWorkerAttempts > 2 ||
    !Number.isInteger(runPolicy.activeWorkDeadlineMs) ||
    runPolicy.activeWorkDeadlineMs < 1 ||
    !Number.isInteger(runPolicy.quotaFreshnessTargetMs) ||
    runPolicy.quotaFreshnessTargetMs < 1 ||
    typeof runPolicy.reservePercentagePoints !== "number" ||
    runPolicy.reservePercentagePoints < 0 ||
    runPolicy.reservePercentagePoints > 100
  ) {
    fail("config run policy is invalid");
  }
  if (!Array.isArray(value.profiles) || !Array.isArray(value.quotaBindings)) {
    fail("config profiles and quotaBindings must be arrays");
  }

  const profileIds = new Set<string>();
  const bindings = new Map<string, QuotaBinding>();
  for (const [index, raw] of value.quotaBindings.entries()) {
    if (
      !isRecord(raw) ||
      !nonEmpty(raw.id) ||
      !Array.isArray(raw.poolIds) ||
      raw.poolIds.some((pool) => !nonEmpty(pool)) ||
      !["installed-account", "user-approved", "unknown"].includes(String(raw.evidence)) ||
      !nonEmpty(raw.note)
    ) {
      fail("quotaBindings[" + index + "] is invalid");
    }
    if (bindings.has(raw.id)) fail("duplicate quota binding id: " + raw.id);
    bindings.set(raw.id, raw as unknown as QuotaBinding);
  }

  const profiles: ExecutionProfile[] = [];
  for (const [index, raw] of value.profiles.entries()) {
    if (isRecord(raw) && nonEmpty(raw.id) && profileIds.has(raw.id)) {
      fail("duplicate profile id: " + raw.id);
    }
    if (
      !isRecord(raw) ||
      !nonEmpty(raw.id) ||
      profileIds.has(raw.id) ||
      typeof raw.enabled !== "boolean" ||
      !nonEmpty(raw.modelId) ||
      raw.speed !== "standard" ||
      !["review", "implement"].includes(String(raw.permissionClass)) ||
      !Array.isArray(raw.riskClasses) ||
      raw.riskClasses.some((risk) => !["low", "material", "critical"].includes(String(risk))) ||
      !nonEmpty(raw.fits) ||
      !["candidate", "qualified"].includes(String(raw.status)) ||
      (raw.quotaBindingId !== null &&
        (!nonEmpty(raw.quotaBindingId) || !bindings.has(raw.quotaBindingId)))
    ) {
      fail("profiles[" + index + "] is invalid");
    }
    if (!isRecord(raw.effort)) fail("profiles[" + index + "].effort is invalid");
    if (
      raw.effort.kind !== "model-default" &&
      (raw.effort.kind !== "explicit" || !nonEmpty(raw.effort.value))
    ) {
      fail("profiles[" + index + "].effort is invalid");
    }
    profileIds.add(raw.id);
    profiles.push(raw as unknown as ExecutionProfile);
  }

  return {
    schemaVersion: 1,
    routing: routing as unknown as RoutingConfig,
    runPolicy: runPolicy as unknown as RunPolicy,
    profiles,
    quotaBindings: [...bindings.values()],
  };
};

export const taskFromUnknown = (value: unknown, fallbackId = "task-local"): TaskInput => {
  if (typeof value === "string") {
    if (!value.trim()) fail("task objective must not be empty");
    return {
      id: fallbackId,
      objective: value.trim(),
      acceptanceCriteria: [],
      scopeHints: [],
      requiredAccess: "read",
      knownRisk: "material",
      verificationAvailability: "unknown",
    };
  }
  if (!isRecord(value) || !nonEmpty(value.objective)) fail("task objective must be a non-empty string");
  const list = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter(nonEmpty).map((item) => item.trim()) : [];
  const requiredAccess = value.requiredAccess === "write" ? "write" : "read";
  const knownRisk = ["low", "material", "critical"].includes(String(value.knownRisk))
    ? (value.knownRisk as RiskClass)
    : "material";
  const verificationAvailability = ["meaningful", "manual-only", "unknown"].includes(
    String(value.verificationAvailability),
  )
    ? (value.verificationAvailability as TaskInput["verificationAvailability"])
    : "unknown";
  return {
    id: nonEmpty(value.id) ? value.id : fallbackId,
    objective: value.objective.trim(),
    acceptanceCriteria: list(value.acceptanceCriteria),
    scopeHints: list(value.scopeHints),
    requiredAccess,
    knownRisk,
    verificationAvailability,
    modalities: list(value.modalities),
  };
};

export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const hashJson = (value: unknown): string =>
  sha256(JSON.stringify(canonicalize(value)));

export const redactSecrets = (value: string): { text: string; redactions: number } => {
  let redactions = 0;
  const replace = (pattern: RegExp, replacement = "[REDACTED]") => {
    value = value.replace(pattern, () => {
      redactions += 1;
      return replacement;
    });
  };
  replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi);
  replace(/\b(?:TYPESAFE_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)\s*=\s*[^\s"'&]+/gi);
  replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi);
  replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*["']?[^"',\s}]+/gi);
  return { text: value, redactions };
};

export const sanitizeTask = (task: TaskInput): { task: TaskInput; redactions: number } => {
  let total = 0;
  const clean = (input: string) => {
    const result = redactSecrets(input);
    total += result.redactions;
    return result.text;
  };
  return {
    task: {
      ...task,
      objective: clean(task.objective),
      acceptanceCriteria: task.acceptanceCriteria.map(clean),
      scopeHints: task.scopeHints.map(clean),
      modalities: task.modalities?.map(clean),
    },
    redactions: total,
  };
};

export const defaultControllerHome = (): string =>
  join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), "CodexQuotaOrchestrator");

export const assertHomeOutsideRepo = (home: string, repo: string): string => {
  const homePath = normalize(resolve(home));
  const repoPath = normalize(resolve(repo));
  const rel = relative(repoPath, homePath);
  if (rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))) {
    fail("controller home must not be inside the active worker checkout");
  }
  return homePath;
};

export const ensureDir = (path: string): void => mkdirSync(path, { recursive: true });

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export const writeJsonAtomic = (path: string, value: unknown): void => {
  ensureDir(dirname(path));
  const temp = path + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(temp, path);
};

export const loadConfig = (path: string): AppConfig => {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  return validateConfig(readJson(path));
};

export const pathInside = (root: string, candidate: string): boolean => {
  const rel = relative(normalize(resolve(root)), normalize(resolve(candidate)));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
};
