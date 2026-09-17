import { cumulativeUsageDelta, type UsageObservation } from "./quota.ts";
import type { RunRecord } from "./run.ts";

export type OutcomeReport = {
  generatedAt: string;
  totals: {
    attempted: number;
    accepted: number;
    rejected: number;
    abandoned: number;
    pendingReview: number;
    failed: number;
    blocked: number;
  };
  byCategory: Record<string, {
    tasks: number;
    attempts: number;
    accepted: number;
    rejected: number;
    verificationStrength: Record<string, number>;
  }>;
  requestedVsObserved: Array<{
    runId: string;
    requestedProfileId: string | null;
    reportedModels: string[];
    reportedEfforts: string[];
    attempts: number;
  }>;
  quotaPools: Record<string, {
    observations: number;
    windows: string[];
    limitations: string[];
  }>;
  typesafe: {
    runsWithUsage: number;
    usageRecords: Array<{ runId: string; usage: Record<string, unknown> }>;
  };
  measurement: {
    status: "insufficient-comparable-baseline" | "comparable-cohort-available";
    limitations: string[];
  };
};

const emptyCategory = () => ({
  tasks: 0,
  attempts: 0,
  accepted: 0,
  rejected: 0,
  verificationStrength: {},
});

const addCount = (map: Record<string, number>, key: string, amount = 1) => {
  map[key] = (map[key] ?? 0) + amount;
};

export const reportRuns = (runs: RunRecord[], generatedAt = new Date().toISOString()): OutcomeReport => {
  const totals = {
    attempted: runs.filter((run) => run.attempts.length > 0).length,
    accepted: runs.filter((run) => run.state === "accepted").length,
    rejected: runs.filter((run) => run.state === "rejected").length,
    abandoned: runs.filter((run) => run.state === "abandoned").length,
    pendingReview: runs.filter((run) => run.state === "awaiting_review").length,
    failed: runs.filter((run) => run.state === "failed" || run.state === "interrupted").length,
    blocked: runs.filter((run) => run.state === "blocked").length,
  };
  const byCategory: OutcomeReport["byCategory"] = {};
  const requestedVsObserved: OutcomeReport["requestedVsObserved"] = [];
  const quotaPools: OutcomeReport["quotaPools"] = {};
  const usageRecords: OutcomeReport["typesafe"]["usageRecords"] = [];

  for (const run of runs) {
    const category = run.task.knownRisk;
    const bucket = (byCategory[category] ??= emptyCategory());
    bucket.tasks += 1;
    bucket.attempts += run.attempts.length;
    if (run.state === "accepted") bucket.accepted += 1;
    if (run.state === "rejected") bucket.rejected += 1;
    if (run.verification) addCount(bucket.verificationStrength, run.verification.strength);
    requestedVsObserved.push({
      runId: run.id,
      requestedProfileId: run.plan.profileId,
      reportedModels: [...new Set(run.attempts.map((attempt) => attempt.actualModelId).filter((value): value is string => Boolean(value)))],
      reportedEfforts: [...new Set(run.attempts.map((attempt) => attempt.actualEffort).filter((value): value is string => Boolean(value)))],
      attempts: run.attempts.length,
    });
    if (run.typesafeUsage) usageRecords.push({ runId: run.id, usage: run.typesafeUsage });
    const quota = run.quotaObservation;
    if (quota && typeof quota === "object" && !Array.isArray(quota)) {
      const pools = Array.isArray((quota as { pools?: unknown }).pools)
        ? ((quota as { pools: unknown[] }).pools)
        : [];
      for (const rawPool of pools) {
        if (!rawPool || typeof rawPool !== "object") continue;
        const pool = rawPool as { id?: unknown; windows?: unknown[]; limitations?: unknown[] };
        const id = typeof pool.id === "string" ? pool.id : "unknown-pool";
        const entry = (quotaPools[id] ??= { observations: 0, windows: [], limitations: [] });
        entry.observations += 1;
        for (const rawWindow of pool.windows ?? []) {
          if (rawWindow && typeof rawWindow === "object" && typeof (rawWindow as { id?: unknown }).id === "string") {
            entry.windows.push((rawWindow as { id: string }).id);
          }
        }
        for (const limitation of (quota as { limitations?: unknown[] }).limitations ?? []) {
          if (typeof limitation === "string") entry.limitations.push(limitation);
        }
      }
    }
  }
  for (const entry of Object.values(quotaPools)) {
    entry.windows = [...new Set(entry.windows)];
    entry.limitations = [...new Set(entry.limitations)];
  }
  const acceptedComparable = runs.filter(
    (run) => run.state === "accepted" && run.verification?.strength === "strong" && run.attempts.length > 0,
  ).length;
  return {
    generatedAt,
    totals,
    byCategory,
    requestedVsObserved,
    quotaPools,
    typesafe: { runsWithUsage: usageRecords.length, usageRecords },
    measurement: {
      status: acceptedComparable >= 2 ? "comparable-cohort-available" : "insufficient-comparable-baseline",
      limitations: [
        "No savings percentage is inferred from route choice, token totals, or one successful task.",
        "Failed, rejected, interrupted, and pending-review runs remain visible in the numerator.",
        "General and Spark observations are reported separately; unknown pool mappings are not filled in.",
        "Typesafe usage is not Codex allowance usage.",
      ],
    },
  };
};

export const accountUsageDeltas = (observations: UsageObservation[]): {
  total: number | null;
  resets: number;
  duplicates: number;
  uncertainties: string[];
} => {
  const last = new Map<string, UsageObservation>();
  let total = 0;
  let hasDelta = false;
  let resets = 0;
  let duplicates = 0;
  const uncertainties: string[] = [];
  for (const observation of observations) {
    const previous = last.get(observation.key) ?? null;
    const delta = cumulativeUsageDelta(previous, observation);
    if (delta.deltaTokens !== null) {
      total += delta.deltaTokens;
      hasDelta = true;
    }
    if (delta.reset) resets += 1;
    if (delta.duplicate) duplicates += 1;
    if (delta.uncertainty) uncertainties.push(delta.uncertainty);
    last.set(observation.key, observation);
  }
  return {
    total: hasDelta ? total : null,
    resets,
    duplicates,
    uncertainties: [...new Set(uncertainties)],
  };
};
