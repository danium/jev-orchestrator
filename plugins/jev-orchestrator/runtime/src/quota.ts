import type {
  AppConfig,
  AuthSnapshot,
  ExecutionProfile,
  ModelCapability,
  QuotaBinding,
} from "./contracts.ts";

export type QuotaWindow = {
  id: string;
  poolId: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  observedAt: string;
  source: "app-server";
};

export type CreditSnapshot = {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: string | null;
};

export type QuotaPool = {
  id: string;
  sourceKey: string;
  normalModelSlug: string | null;
  windows: QuotaWindow[];
  ordinaryUsageAllowed: boolean | null;
  spendControlReached: boolean | null;
  credits: CreditSnapshot | null;
  observedAt: string;
};

export type QuotaSnapshot = {
  schemaVersion: 1;
  observedAt: string;
  account: AuthSnapshot;
  pools: QuotaPool[];
  shape: "legacy-single-pool" | "multi-pool" | "empty";
  creditSafety: "unknown";
  limitations: string[];
};

export type QuotaDecision = {
  eligible: boolean;
  bindingId: string | null;
  poolIds: string[];
  reasons: string[];
  warnings: string[];
  observedAt: string | null;
  creditSafety: "unknown";
};

export type UsageObservation = {
  key: string;
  observedAt: string;
  cumulativeTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  eventId: string | null;
  poolId: string | null;
  windowId: string | null;
};

export type UsageDelta = {
  deltaTokens: number | null;
  reset: boolean;
  duplicate: boolean;
  zeroResolution: boolean;
  uncertainty: string | null;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const finiteInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) ? value : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const normalizeWindow = (
  poolId: string,
  label: string,
  raw: unknown,
  observedAt: string,
): QuotaWindow | null => {
  if (raw === null || raw === undefined) return null;
  const value = record(raw);
  const usedPercent = finiteInteger(value.usedPercent);
  const remainingPercent =
    usedPercent === null || usedPercent < 0 || usedPercent > 100 ? null : 100 - usedPercent;
  const resetsAt = finiteInteger(value.resetsAt);
  const windowDurationMins = finiteInteger(value.windowDurationMins);
  return {
    id: poolId + ":" + label,
    poolId,
    label,
    usedPercent,
    remainingPercent,
    windowDurationMins,
    resetsAt,
    observedAt,
    source: "app-server",
  };
};

const normalizePool = (
  poolId: string,
  sourceKey: string,
  raw: unknown,
  observedAt: string,
): QuotaPool => {
  const value = record(raw);
  const windows = ["primary", "secondary"]
    .map((label) => normalizeWindow(poolId, label, value[label], observedAt))
    .filter((window): window is QuotaWindow => window !== null);
  const creditsValue = value.credits;
  const credits = creditsValue === null || creditsValue === undefined
    ? null
    : {
        hasCredits:
          typeof record(creditsValue).hasCredits === "boolean"
            ? (record(creditsValue).hasCredits as boolean)
            : null,
        unlimited:
          typeof record(creditsValue).unlimited === "boolean"
            ? (record(creditsValue).unlimited as boolean)
            : null,
        balance: nonEmpty(record(creditsValue).balance),
      };
  return {
    id: poolId,
    sourceKey,
    normalModelSlug: nonEmpty(value.normalModelSlug),
    windows,
    ordinaryUsageAllowed:
      typeof value.ordinaryUsageAllowed === "boolean" ? value.ordinaryUsageAllowed : null,
    spendControlReached:
      typeof value.spendControlReached === "boolean" ? value.spendControlReached : null,
    credits,
    observedAt,
  };
};

export const normalizeAccount = (response: unknown, observedAt = new Date().toISOString()): AuthSnapshot => {
  const value = record(response);
  const account = record(value.account);
  const type = account.type;
  const provider =
    type === "chatgpt" ? "chatgpt" : type === "apiKey" ? "api" : type === "amazonBedrock" ? "bedrock" : "unknown";
  return {
    provider,
    authenticated: Boolean(account.type),
    managedLogin: provider === "chatgpt",
    accountId: nonEmpty(value.accountId) ?? null,
    planType: nonEmpty(account.planType),
    requiresOpenaiAuth:
      typeof value.requiresOpenaiAuth === "boolean" ? value.requiresOpenaiAuth : null,
    observedAt,
  };
};

export const normalizeQuotaResponse = (
  response: unknown,
  account: AuthSnapshot,
  observedAt = new Date().toISOString(),
): QuotaSnapshot => {
  const value = record(response);
  const byLimitId = record(value.rateLimitsByLimitId);
  const pools: QuotaPool[] = [];
  for (const [key, raw] of Object.entries(byLimitId)) {
    const pool = normalizePool(nonEmpty(record(raw).limitId) ?? key, key, raw, observedAt);
    pools.push(pool);
  }
  if (pools.length === 0 && value.rateLimits !== undefined && value.rateLimits !== null) {
    const raw = record(value.rateLimits);
    pools.push(normalizePool(nonEmpty(raw.limitId) ?? "legacy-general", "legacy", raw, observedAt));
  }
  const ordinaryUsageAllowed =
    typeof value.ordinaryUsageAllowed === "boolean" ? value.ordinaryUsageAllowed : null;
  if (ordinaryUsageAllowed !== null) {
    for (const pool of pools) pool.ordinaryUsageAllowed = ordinaryUsageAllowed;
  }
  return {
    schemaVersion: 1,
    observedAt,
    account: {
      ...account,
      accountId: nonEmpty(value.accountId) ?? account.accountId,
    },
    pools,
    shape: byLimitId && Object.keys(byLimitId).length > 0
      ? "multi-pool"
      : pools.length > 0
        ? "legacy-single-pool"
        : "empty",
    creditSafety: "unknown",
    limitations: [
      "The server response does not establish a client-enforced purchased-credit hard cap.",
      "Pool membership is explicit configuration; model names are never used to infer it.",
    ],
  };
};

const mergeWindow = (oldWindow: QuotaWindow, nextWindow: QuotaWindow): QuotaWindow => ({
  ...oldWindow,
  ...nextWindow,
  usedPercent: nextWindow.usedPercent ?? oldWindow.usedPercent,
  remainingPercent: nextWindow.remainingPercent ?? oldWindow.remainingPercent,
  windowDurationMins: nextWindow.windowDurationMins ?? oldWindow.windowDurationMins,
  resetsAt: nextWindow.resetsAt ?? oldWindow.resetsAt,
});

const mergePool = (oldPool: QuotaPool, nextPool: QuotaPool): QuotaPool => {
  const nextById = new Map(nextPool.windows.map((window) => [window.id, window]));
  const windows = oldPool.windows.map((window) =>
    nextById.has(window.id) ? mergeWindow(window, nextById.get(window.id) as QuotaWindow) : window,
  );
  for (const window of nextPool.windows) {
    if (!oldPool.windows.some((candidate) => candidate.id === window.id)) windows.push(window);
  }
  return {
    ...oldPool,
    ...nextPool,
    windows,
    normalModelSlug: nextPool.normalModelSlug ?? oldPool.normalModelSlug,
    ordinaryUsageAllowed: nextPool.ordinaryUsageAllowed ?? oldPool.ordinaryUsageAllowed,
    spendControlReached: nextPool.spendControlReached ?? oldPool.spendControlReached,
    credits: nextPool.credits ?? oldPool.credits,
  };
};

export const mergeQuotaSnapshots = (
  previous: QuotaSnapshot | null,
  update: QuotaSnapshot,
): QuotaSnapshot => {
  if (!previous) return update;
  const nextById = new Map(update.pools.map((pool) => [pool.id, pool]));
  const pools = previous.pools.map((pool) =>
    nextById.has(pool.id) ? mergePool(pool, nextById.get(pool.id) as QuotaPool) : pool,
  );
  for (const pool of update.pools) {
    if (!previous.pools.some((candidate) => candidate.id === pool.id)) pools.push(pool);
  }
  return {
    ...previous,
    observedAt: update.observedAt,
    account: {
      ...previous.account,
      ...update.account,
      accountId: update.account.accountId ?? previous.account.accountId,
      planType: update.account.planType ?? previous.account.planType,
      provider: update.account.provider === "unknown" ? previous.account.provider : update.account.provider,
      managedLogin: update.account.provider === "unknown" ? previous.account.managedLogin : update.account.managedLogin,
    },
    pools,
    shape: update.shape === "empty" ? previous.shape : update.shape,
    limitations: [...new Set([...previous.limitations, ...update.limitations])],
  };
};

const bindingFor = (profile: ExecutionProfile, config: AppConfig): QuotaBinding | null =>
  profile.quotaBindingId
    ? config.quotaBindings.find((binding) => binding.id === profile.quotaBindingId) ?? null
    : null;

export const quotaDecision = (
  profile: ExecutionProfile,
  config: AppConfig,
  snapshot: QuotaSnapshot | null,
  capabilities: ModelCapability[],
  nowMs = Date.now(),
): QuotaDecision => {
  const reasons: string[] = [];
  const warnings: string[] = ["purchased-credit overflow protection is not established"];
  const binding = bindingFor(profile, config);
  if (!snapshot) {
    return {
      eligible: false,
      bindingId: profile.quotaBindingId,
      poolIds: binding?.poolIds ?? [],
      reasons: ["no quota snapshot"],
      warnings,
      observedAt: null,
      creditSafety: "unknown",
    };
  }
  if (snapshot.account.provider !== "chatgpt" || !snapshot.account.managedLogin) {
    reasons.push("managed ChatGPT authentication is required");
  }
  if (!snapshot.account.authenticated) reasons.push("account is not authenticated");
  if (!binding) reasons.push("profile has no explicit quota binding");
  if (binding?.evidence === "unknown") reasons.push("quota binding evidence is unknown");
  if (
    binding &&
    binding.modelIds &&
    binding.modelIds.length > 0 &&
    !binding.modelIds.includes(profile.modelId)
  ) {
    reasons.push("profile model is not in the explicit quota binding");
  }
  const capability = capabilities.find((candidate) => candidate.id === profile.modelId);
  if (!capability) reasons.push("model is not in the installed capability snapshot");
  const observedMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedMs)) {
    reasons.push("quota observation timestamp is invalid");
  } else if (nowMs - observedMs > config.runPolicy.quotaFreshnessTargetMs) {
    reasons.push("quota snapshot is stale");
  }
  if (binding && snapshot.account.accountId === null) {
    warnings.push("account identity is unavailable; concurrency contamination cannot be ruled out");
  }
  const pools = binding
    ? snapshot.pools.filter((pool) => binding.poolIds.includes(pool.id))
    : [];
  if (binding && pools.length === 0) reasons.push("explicit quota pools are absent from the snapshot");
  const usablePools = pools.filter((pool) => {
    if (pool.ordinaryUsageAllowed === false || pool.spendControlReached === true) return false;
    return pool.windows.length > 0 && pool.windows.every((window) => {
      if (window.remainingPercent === null) return false;
      if (window.resetsAt !== null && window.resetsAt * 1000 <= nowMs && observedMs <= window.resetsAt * 1000) {
        return false;
      }
      return window.remainingPercent > config.runPolicy.reservePercentagePoints;
    });
  });
  if (pools.length > 0 && usablePools.length === 0) {
    reasons.push("all explicitly applicable quota windows are exhausted, reserved, or unknown");
  }
  return {
    eligible: reasons.length === 0 && usablePools.length > 0,
    bindingId: profile.quotaBindingId,
    poolIds: binding?.poolIds ?? [],
    reasons,
    warnings,
    observedAt: snapshot.observedAt,
    creditSafety: "unknown",
  };
};

export const cumulativeUsageDelta = (
  previous: UsageObservation | null,
  current: UsageObservation,
): UsageDelta => {
  if (previous && previous.eventId && current.eventId && previous.eventId === current.eventId) {
    return {
      deltaTokens: 0,
      reset: false,
      duplicate: true,
      zeroResolution: false,
      uncertainty: null,
    };
  }
  if (current.cumulativeTokens === null || !Number.isFinite(current.cumulativeTokens)) {
    return {
      deltaTokens: null,
      reset: false,
      duplicate: false,
      zeroResolution: false,
      uncertainty: "cumulative token counter is missing",
    };
  }
  if (!previous || previous.cumulativeTokens === null) {
    return {
      deltaTokens: null,
      reset: false,
      duplicate: false,
      zeroResolution: false,
      uncertainty: "first cumulative observation has no baseline",
    };
  }
  if (current.cumulativeTokens < previous.cumulativeTokens) {
    return {
      deltaTokens: null,
      reset: true,
      duplicate: false,
      zeroResolution: false,
      uncertainty: "counter decreased; a reset or account/window change occurred",
    };
  }
  const deltaTokens = current.cumulativeTokens - previous.cumulativeTokens;
  return {
    deltaTokens,
    reset: false,
    duplicate: false,
    zeroResolution: deltaTokens === 0,
    uncertainty: deltaTokens === 0 ? "counter resolution produced no measurable delta" : null,
  };
};
