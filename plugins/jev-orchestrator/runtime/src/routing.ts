import { setTimeout as sleepTimer } from "node:timers/promises";
import {
  hashJson,
  redactSecrets,
  sanitizeTask,
  type AppConfig,
  type ExecutionProfile,
  type ModelCapability,
  type Plan,
  type TaskInput,
} from "./contracts.ts";
import { quotaDecision, type QuotaDecision, type QuotaSnapshot } from "./quota.ts";

export type EligibleProfile = {
  profile: ExecutionProfile;
  reasons: string[];
  quota: QuotaDecision;
};

export type ChoiceRequest = {
  state: {
    task: {
      id: string;
      objective: string;
      acceptanceCriteria: string[];
      scopeHints: string[];
      requiredAccess: string;
      knownRisk: string;
      verificationAvailability: string;
      modalities?: string[];
    };
  };
  model: string;
  questions: {
    pick: {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    };
  };
};

export type JevAnswer = {
  key: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type FetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
};

export type Fetcher = (url: string, init: RequestInit) => Promise<FetchResponse>;

export type RouteOptions = {
  config: AppConfig;
  task: TaskInput;
  capabilities: ModelCapability[];
  quota: QuotaSnapshot | null;
  repository: Plan["repository"];
  verificationPlanHash?: string | null;
  typesafeKey?: string | null;
  typesafeConsent?: boolean;
  offline?: boolean;
  allowObservedPoolSet?: boolean;
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type RouteResult = {
  plan: Plan;
  eligible: EligibleProfile[];
  dropped: Array<{ profileId: string; reasons: string[] }>;
  request: ChoiceRequest | null;
  attempts: number;
  errors: string[];
  redactions: number;
  transportUncertain: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const effortValue = (profile: ExecutionProfile): string | null =>
  profile.effort.kind === "explicit" ? profile.effort.value : null;

const candidateReasons = (
  profile: ExecutionProfile,
  task: TaskInput,
  capabilities: ModelCapability[],
  config: AppConfig,
): string[] => {
  const reasons: string[] = [];
  const capability = capabilities.find((candidate) => candidate.id === profile.modelId);
  if (!capability) {
    reasons.push("model is absent from the installed capability snapshot");
    return reasons;
  }
  if (
    profile.effort.kind === "explicit" &&
    !capability.supportedReasoningEfforts.includes(profile.effort.value)
  ) {
    reasons.push("requested reasoning effort is not advertised by the installed model");
  }
  if (task.requiredAccess === "write" && profile.permissionClass !== "implement") {
    reasons.push("read-only profile cannot satisfy a write task");
  }
  if (!profile.riskClasses.includes(task.knownRisk)) {
    reasons.push("profile is not approved for this risk class");
  }
  if (
    task.modalities &&
    task.modalities.length > 0 &&
    task.modalities.some((modality) => !(capability.inputModalities ?? ["text"]).includes(modality))
  ) {
    reasons.push("profile does not advertise every required input modality");
  }
  if (config.routing.provider !== "typesafe") reasons.push("unsupported routing provider");
  return reasons;
};

export const eligibleProfiles = (
  task: TaskInput,
  config: AppConfig,
  capabilities: ModelCapability[],
  quota: QuotaSnapshot | null,
  nowMs = Date.now(),
  options: { allowObservedPoolSet?: boolean } = {},
): { eligible: EligibleProfile[]; dropped: Array<{ profileId: string; reasons: string[] }> } => {
  const eligible: EligibleProfile[] = [];
  const dropped: Array<{ profileId: string; reasons: string[] }> = [];
  for (const profile of config.profiles) {
    const reasons = profile.enabled ? candidateReasons(profile, task, capabilities, config) : ["profile is disabled"];
    const quotaResult = quotaDecision(profile, config, quota, capabilities, nowMs, options);
    const allReasons = [...reasons, ...quotaResult.reasons];
    if (allReasons.length === 0) {
      eligible.push({
        profile,
        reasons: [
          ...quotaResult.warnings,
          ...(profile.status === "candidate" ? ["candidate profile requires explicit route confirmation"] : []),
        ],
        quota: quotaResult,
      });
    } else {
      dropped.push({ profileId: profile.id, reasons: [...allReasons, ...quotaResult.warnings] });
    }
  }
  return { eligible, dropped };
};

export const buildChoiceRequest = (task: TaskInput, candidates: EligibleProfile[], model: string): ChoiceRequest => {
  const sanitized = sanitizeTask(task).task;
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[candidate.profile.id] =
      "Use this exact profile for " +
      candidate.profile.fits +
      " It has explicit permission class " +
      candidate.profile.permissionClass +
      " and risk classes " +
      candidate.profile.riskClasses.join(", ") +
      ".";
  }
  criteria.needs_information =
    "Do not execute. Ask one focused question because the objective, access, risk, or verification requirement is missing.";
  criteria.defer_no_suitable_route =
    "Do not execute. None of the eligible profiles is a suitable or safe match.";
  return {
    state: { task: sanitized },
    model,
    questions: {
      pick: {
        type: "choice",
        instructions:
          "Choose only an eligible execution profile when its fit, permission, risk, and verification boundaries match the task. Keep needs_information or defer_no_suitable_route when execution is not justified.",
        criteria,
      },
    },
  };
};

const finiteUnit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export const validateJevAnswer = (body: unknown, allowedKeys: string[]): JevAnswer => {
  if (!isRecord(body) || !isRecord(body.answers) || !isRecord(body.answers.pick)) {
    throw new Error("response carried no choice answer");
  }
  const answer = body.answers.pick;
  if (answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new Error("response choice answer has the wrong shape");
  }
  const allowed = new Set(allowedKeys);
  if (!allowed.has(answer.choice)) throw new Error("response selected an unknown choice");
  if (!finiteUnit(answer.confidence)) throw new Error("response confidence is not finite and in range");
  if (!isRecord(answer.probabilities)) throw new Error("response probabilities are missing");
  const keys = Object.keys(answer.probabilities).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("response probabilities do not exactly match the choice set");
  }
  let sum = 0;
  let highest = -1;
  for (const key of expected) {
    const probability = answer.probabilities[key];
    if (!finiteUnit(probability)) throw new Error("response probability is invalid");
    sum += probability;
    highest = Math.max(highest, probability);
  }
  if (Math.abs(sum - 1) > 0.001) throw new Error("response probabilities do not sum to one");
  if (answer.probabilities[answer.choice] < highest - 0.000001) {
    throw new Error("response choice is not among the highest-probability options");
  }
  return {
    key: answer.choice,
    confidence: answer.confidence,
    probabilities: Object.fromEntries(expected.map((key) => [key, answer.probabilities[key]])),
  };
};

const planBase = (
  options: RouteOptions,
  status: Plan["status"],
  routeSource: Plan["routeSource"],
  profileId: string | null,
  eligibilityReasons: string[],
  quotaBindingEvidence: string[],
  confidence: number | null,
  probabilities: Record<string, number> | null,
  typesafe: Plan["typesafe"],
): Plan => {
  const profile = profileId
    ? options.config.profiles.find((candidate) => candidate.id === profileId) ?? null
    : null;
  return {
    schemaVersion: 1,
    taskId: options.task.id,
    profileId,
    requested: {
      modelId: profile?.modelId ?? null,
      effort: profile ? effortValue(profile) : null,
      speed: profile ? profile.speed : null,
      permissionClass: profile?.permissionClass ?? null,
    },
    eligibilityReasons,
    quotaBindingEvidence,
    policyHash: hashJson(options.config),
    repository: options.repository,
    verificationPlanHash: options.verificationPlanHash ?? null,
    knownLimitations: [
      "A route recommendation is not permission to execute.",
      "A ChatGPT login does not establish purchased-credit overflow protection.",
      "One route or one accepted task cannot establish savings.",
    ],
    maximumAttempts: options.config.runPolicy.maxWorkerAttempts,
    status,
    routeSource,
    confidence,
    probabilities,
    typesafe,
  };
};

const manualResult = (
  options: RouteOptions,
  eligible: EligibleProfile[],
  dropped: Array<{ profileId: string; reasons: string[] }>,
  request: ChoiceRequest | null,
  reason: string,
  routeSource: "offline" | "manual" = "offline",
): RouteResult => ({
  plan: planBase(
    options,
    eligible.length > 0 ? "manual-preview" : "blocked",
    routeSource,
    null,
    [reason, ...dropped.flatMap((item) => item.reasons)],
    eligible.flatMap((item) => item.profile.quotaBindingId ? [item.profile.quotaBindingId] : []),
    null,
    null,
    { model: null, responseVersion: null, usage: null },
  ),
  eligible,
  dropped,
  request,
  attempts: 0,
  errors: [],
  redactions: request ? 0 : 0,
  transportUncertain: false,
});

const retryableStatus = (status: number): boolean =>
  [408, 425, 429, 500, 502, 503, 504, 529].includes(status);

const retryAfterMs = (response: FetchResponse): number => {
  const raw = response.headers?.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 5000) : 0;
};

const globalFetcher: Fetcher = async (url, init) => {
  const response = await fetch(url, init);
  return response as unknown as FetchResponse;
};

export const routeTask = async (options: RouteOptions): Promise<RouteResult> => {
  const nowMs = options.now?.() ?? Date.now();
  const { eligible, dropped } = eligibleProfiles(
    options.task,
    options.config,
    options.capabilities,
    options.quota,
    nowMs,
    { allowObservedPoolSet: options.allowObservedPoolSet },
  );
  const request = buildChoiceRequest(options.task, eligible, options.config.routing.model);
  if (eligible.length === 0) return manualResult(options, eligible, dropped, request, "no eligible profile");
  if (options.offline || !options.typesafeKey || options.typesafeConsent !== true) {
    return manualResult(
      options,
      eligible,
      dropped,
      request,
      options.offline ? "offline mode was requested" : "Typesafe disclosure/consent or key is missing",
    );
  }

  const fetcher = options.fetcher ?? globalFetcher;
  const wait = options.sleep ?? (async (ms: number) => {
    await sleepTimer(ms);
  });
  const deadline = nowMs + options.config.routing.totalDeadlineMs;
  const allowedKeys = [...eligible.map((item) => item.profile.id), "needs_information", "defer_no_suitable_route"];
  const errors: string[] = [];
  let attempts = 0;
  let transportUncertain = false;
  let answer: JevAnswer | null = null;
  let usage: Record<string, unknown> | null = null;
  let responseVersion: string | null = null;
  for (let index = 0; index < options.config.routing.maxTotalAttempts; index += 1) {
    if ((options.now?.() ?? Date.now()) >= deadline) {
      errors.push("Typesafe deadline expired");
      break;
    }
    attempts += 1;
    const controller = new AbortController();
    const remaining = Math.max(1, deadline - (options.now?.() ?? Date.now()));
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + options.typesafeKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        errors.push("typesafe " + response.status + " " + response.statusText);
        if (!retryableStatus(response.status) || index + 1 >= options.config.routing.maxTotalAttempts) break;
        await wait(Math.min(retryAfterMs(response) || 50 * (index + 1), Math.max(0, deadline - Date.now())));
        continue;
      }
      const body = await response.json();
      try {
        answer = validateJevAnswer(body, allowedKeys);
      } catch (error) {
        errors.push(redactSecrets(String(error)).text);
        break;
      }
      const bodyRecord = isRecord(body) ? body : {};
      usage = isRecord(bodyRecord.usage) ? bodyRecord.usage : null;
      responseVersion =
        (typeof bodyRecord.model === "string" && bodyRecord.model) ||
        response.headers?.get("x-typesafe-model") ||
        options.config.routing.model;
      break;
    } catch (error) {
      transportUncertain = true;
      errors.push(redactSecrets(String(error)).text);
      if (index + 1 >= options.config.routing.maxTotalAttempts) break;
      await wait(Math.min(50 * (index + 1), Math.max(0, deadline - Date.now())));
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!answer) {
    return {
      ...manualResult(options, eligible, dropped, request, "Typesafe did not return a valid route", "manual"),
      attempts,
      errors,
      transportUncertain,
    };
  }
  if (answer.key === "needs_information" || answer.key === "defer_no_suitable_route") {
    return {
      ...manualResult(options, eligible, dropped, request, answer.key, "typesafe"),
      plan: planBase(
        options,
        "deferred",
        "typesafe",
        null,
        [answer.key],
        [],
        answer.confidence,
        answer.probabilities,
        { model: responseVersion, responseVersion, usage },
      ),
      attempts,
      errors,
      transportUncertain,
    };
  }
  const selected = eligible.find((candidate) => candidate.profile.id === answer?.key);
  if (!selected) {
    return {
      ...manualResult(options, eligible, dropped, request, "validated selection was not eligible", "typesafe"),
      attempts,
      errors,
      transportUncertain,
    };
  }
  return {
    plan: planBase(
      options,
      "awaiting-route-confirmation",
      "typesafe",
      selected.profile.id,
      [...selected.reasons, "explicit confirmation is still required"],
      selected.profile.quotaBindingId ? [selected.profile.quotaBindingId] : [],
      answer.confidence,
      answer.probabilities,
      { model: responseVersion, responseVersion, usage },
    ),
    eligible,
    dropped,
    request,
    attempts,
    errors,
    redactions: sanitizeTask(options.task).redactions,
    transportUncertain,
  };
};

export const confirmPlan = (plan: Plan, profileId: string): Plan => {
  if (plan.status !== "awaiting-route-confirmation" && plan.status !== "manual-preview") {
    throw new Error("plan is not awaiting route confirmation");
  }
  if (plan.profileId !== profileId) throw new Error("confirmed profile does not match the plan");
  return { ...plan, status: "confirmed" };
};
