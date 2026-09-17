import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHomeOutsideRepo,
  defaultControllerHome,
  loadConfig,
  readJson,
  taskFromUnknown,
  writeJsonAtomic,
  type AppConfig,
  type ModelCapability,
  type TaskInput,
} from "./contracts.ts";
import {
  CodexAppServer,
  environmentKind,
  protocolSchemaAvailable,
  resolveExecutable,
  runExecutable,
  type WorkerRunResult,
} from "./codex.ts";
import { normalizeQuotaResponse, quotaDecision } from "./quota.ts";
import { routeTask, confirmPlan } from "./routing.ts";
import { reportRuns } from "./report.ts";
import { RunStore, type Worker } from "./run.ts";
import { basicConfig, projectConfigDraft, writeSetupArtifacts } from "./setup.ts";
import { inspectGit, artifactFingerprint, type ProjectVerification } from "./workspace.ts";

type Args = {
  command: string;
  flags: Set<string>;
  values: Map<string, string>;
  positionals: string[];
};

const parseArgs = (argv: string[]): Args => {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const [key, inline] = item.slice(2).split("=", 2);
    if (inline !== undefined) values.set(key, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) values.set(key, argv[++index]);
    else flags.add(key);
  }
  return { command: positionals.shift() ?? "help", flags, values, positionals };
};

const value = (args: Args, key: string, fallback?: string): string | undefined =>
  args.values.get(key) ?? fallback;

const output = (args: Args, data: unknown): void => {
  if (args.flags.has("json")) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (typeof data === "string") console.log(data);
  else console.log(JSON.stringify(data, null, 2));
};

const homeFor = (args: Args): string =>
  resolve(value(args, "home", process.env.CODEX_ORCHESTRATOR_HOME ?? defaultControllerHome()) as string);

const configFor = (args: Args, home: string): AppConfig =>
  loadConfig(value(args, "profiles-file", join(home, "profiles.json")) as string);

const taskFor = (args: Args): TaskInput => {
  const path = value(args, "task-file");
  if (!path) {
    const objective = value(args, "objective");
    if (!objective) throw new Error("provide --task-file or --objective");
    return taskFromUnknown(objective);
  }
  const raw = readFileSync(resolve(path), "utf8");
  try {
    return taskFromUnknown(JSON.parse(raw), "task-" + Date.now());
  } catch {
    return taskFromUnknown(raw, "task-" + Date.now());
  }
};

const quotaFor = (home: string): ReturnType<typeof JSON.parse> | null => {
  const path = join(home, "quota.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};

const capabilitiesFor = (args: Args, home: string): ModelCapability[] => {
  const path = value(args, "capabilities-file", join(home, "capabilities.json")) as string;
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!Array.isArray(raw)) throw new Error("capabilities file must contain an array");
  return raw as ModelCapability[];
};

const projectVerificationFor = (repo: string): ProjectVerification => {
  const path = join(repo, ".codex-orchestrator.json");
  if (!existsSync(path)) {
    return { schemaVersion: 1, mode: "unconfigured", checks: [] };
  }
  const raw = readJson<Record<string, unknown>>(path);
  const verification = raw.verification;
  if (!verification || typeof verification !== "object") {
    return { schemaVersion: 1, mode: "unconfigured", checks: [] };
  }
  return verification as ProjectVerification;
};

const doctor = async (args: Args): Promise<unknown> => {
  const repo = value(args, "repo", process.cwd()) as string;
  const home = assertHomeOutsideRepo(homeFor(args), repo);
  const codex = resolveExecutable("codex");
  const git = resolveExecutable("git");
  const versions: Record<string, unknown> = {};
  if (codex) {
    const result = await runExecutable(codex, ["--version"], { cwd: repo, timeoutMs: 10000 });
    versions.codex = { path: codex.path, native: codex.native, code: result.code, version: result.stdout.trim() };
  } else {
    versions.codex = { path: null, native: false, version: null };
  }
  if (git) {
    const result = await runExecutable(git, ["--version"], { cwd: repo, timeoutMs: 10000 });
    versions.git = { path: git.path, code: result.code, version: result.stdout.trim() };
  } else {
    versions.git = { path: null, version: null };
  }
  const inspection = await inspectGit(repo);
  let nativeMetadata: Record<string, unknown> = {
    status: "not-run",
    note: "Use --native-metadata only for a read-only App Server compatibility check.",
  };
  if (args.flags.has("native-metadata")) {
    if (!codex) {
      nativeMetadata = { status: "unavailable", note: "native codex.exe was not resolved" };
    } else {
      const server = CodexAppServer.start({ executable: codex, cwd: repo });
      try {
        await server.initialize();
        const account = await server.account();
        const models = await server.models();
        const rawQuota = await server.rateLimits();
        const snapshot = normalizeQuotaResponse(rawQuota, account.auth);
        nativeMetadata = {
          status: "read",
          authentication: account.auth,
          models: models.map((model) => ({
            id: model.id,
            supportedReasoningEfforts: model.supportedReasoningEfforts,
            inputModalities: model.inputModalities,
            serviceTiers: model.serviceTiers,
          })),
          quota: snapshot,
          note: "Metadata only; no thread/start or turn/start was sent.",
        };
      } catch (error) {
        nativeMetadata = {
          status: "failed",
          error: String(error),
          diagnostics: server.diagnostics(),
        };
      } finally {
        await server.close();
      }
    }
  }
  output(args, {
    package: { version: "0.1.0", home },
    environment: environmentKind(),
    node: process.version,
    repository: inspection,
    executables: versions,
    protocol: {
      snapshot: protocolSchemaAvailable(),
      generatedBy: "codex app-server generate-json-schema --experimental",
    },
    authentication: {
      status: "not-read",
      note: "doctor does not read auth.json, switch accounts, or copy tokens; managed ChatGPT account compatibility remains a native metadata gate",
    },
    quota: {
      status: "not-read",
      note: "no model turn or account/rateLimits/read request was made",
    },
    nativeMetadata,
    globalConfiguration: {
      mutated: false,
      note: "global Codex configuration is not changed by this command",
    },
    gates: {
      nativeWorker: "unverified",
      liveTypesafe: "unverified",
      purchasedCreditHardCap: "unknown",
      wslStatus: "not established in this environment",
    },
  });
  return null;
};

const profiles = (args: Args): void => {
  const home = homeFor(args);
  const config = configFor(args, home);
  output(args, {
    profiles: config.profiles.map((profile) => ({
      id: profile.id,
      enabled: profile.enabled,
      modelId: profile.modelId,
      effort: profile.effort,
      permissionClass: profile.permissionClass,
      riskClasses: profile.riskClasses,
      status: profile.status,
      quotaBindingId: profile.quotaBindingId,
    })),
    quotaBindings: config.quotaBindings,
  });
};

const quota = (args: Args): void => {
  const home = homeFor(args);
  const snapshot = quotaFor(home);
  output(args, snapshot ?? {
    status: "unknown",
    path: join(home, "quota.json"),
    note: "No native or fixture quota snapshot is available. Unknown is not unlimited.",
  });
};

const route = async (args: Args): Promise<void> => {
  const repo = resolve(value(args, "repo", process.cwd()) as string);
  const home = assertHomeOutsideRepo(homeFor(args), repo);
  const config = configFor(args, home);
  const task = taskFor(args);
  const inspection = await inspectGit(repo);
  const result = await routeTask({
    config,
    task,
    capabilities: capabilitiesFor(args, home),
    quota: quotaFor(home),
    repository: {
      path: inspection.path,
      identity: inspection.identity,
      baseRevision: inspection.revision,
    },
    offline: args.flags.has("offline"),
    typesafeKey: process.env.TYPESAFE_API_KEY ?? null,
    typesafeConsent: args.flags.has("consent"),
  });
  output(args, result);
};

const init = (args: Args): void => {
  const repo = resolve(value(args, "repo", process.cwd()) as string);
  const home = assertHomeOutsideRepo(homeFor(args), repo);
  const profilePath = join(home, "profiles.json");
  const projectPath = join(repo, ".codex-orchestrator.json");
  if (existsSync(profilePath) || existsSync(projectPath)) {
    throw new Error("init refuses to overwrite existing policy; review the files and update them explicitly");
  }
  writeJsonAtomic(profilePath, loadConfig(profilePath));
  writeJsonAtomic(projectPath, projectConfigDraft());
  output(args, { created: [profilePath, projectPath], note: "Nothing is enabled or approved by this draft." });
};

const setup = async (args: Args): Promise<void> => {
  const repo = resolve(value(args, "repo", process.cwd()) as string);
  const home = assertHomeOutsideRepo(homeFor(args), repo);
  const executable = resolveExecutable("codex");
  if (!executable) throw new Error("native codex.exe is unavailable");
  const server = CodexAppServer.start({ executable, cwd: repo });
  try {
    await server.initialize();
    const account = await server.account();
    const capabilities = await server.models();
    const quota = normalizeQuotaResponse(await server.rateLimits(), account.auth);
    output(args, writeSetupArtifacts({
      home,
      repo,
      authentication: account.auth,
      capabilities,
      quota,
    }));
  } finally {
    await server.close();
  }
};

const liveWorkerAllowed = (args: Args): boolean =>
  args.flags.has("allow-live") && process.env.CODEX_ORCHESTRATOR_CONFIRM_LIVE === "I_AUTHORIZE";

const executeConfirmedRun = async (input: {
  args: Args;
  server: CodexAppServer;
  home: string;
  task: TaskInput;
  plan: ReturnType<typeof confirmPlan>;
  inspection: Awaited<ReturnType<typeof inspectGit>>;
  quota: ReturnType<typeof normalizeQuotaResponse>;
}): Promise<void> => {
  const store = new RunStore({ home: input.home });
  const runId = value(input.args, "run-id", "run-" + Date.now()) as string;
  const baseFingerprint = artifactFingerprint(input.inspection.path, input.inspection);
  const record = store.create(runId, input.task, input.plan, input.inspection, baseFingerprint, input.quota);
  const worker: Worker = {
    async run(workerInput) {
      let result: WorkerRunResult;
      try {
        result = await input.server.runTurn(
          workerInput.profile.modelId,
          workerInput.profile.effort.kind === "explicit" ? workerInput.profile.effort.value : null,
          workerInput.repo,
          workerInput.prompt,
        );
      } catch (error) {
        return {
          ok: false,
          retryable: false,
          category: "transport-unknown",
          actualModelId: null,
          actualEffort: null,
          detail: String(error),
        };
      }
      return {
        ok: result.status === "completed",
        retryable: false,
        category: result.status === "completed" ? "completed" : "failed",
        actualModelId: result.actualModelId,
        actualEffort: result.actualEffort,
        detail: result.messages.join("").slice(-2000) || result.status,
      };
    },
    interrupt: () => input.server.interrupt(),
  };
  output(input.args, await store.execute(record.id, projectVerificationFor(input.inspection.path), worker));
};

const runLive = async (args: Args): Promise<void> => {
  if (!liveWorkerAllowed(args)) {
    throw new Error("live worker execution is blocked; use --allow-live and CODEX_ORCHESTRATOR_CONFIRM_LIVE=I_AUTHORIZE after native gates pass");
  }
  const repo = resolve(value(args, "repo", process.cwd()) as string);
  const home = assertHomeOutsideRepo(homeFor(args), repo);
  const config = configFor(args, home);
  const task = taskFor(args);
  const executable = resolveExecutable("codex");
  if (!executable) throw new Error("native codex.exe is unavailable");
  const server = CodexAppServer.start({ executable, cwd: repo, allowLive: true });
  const account = await server.initialize().then(() => server.account());
  if (!account.auth.managedLogin) {
    await server.close();
    throw new Error("live worker requires managed ChatGPT authentication; no account switch or API fallback is attempted");
  }
  const capabilities = await server.models();
  const rateLimits = await server.rateLimits();
  const quota = normalizeQuotaResponse(rateLimits, account.auth);
  const inspection = await inspectGit(repo);
  const routed = await routeTask({
    config,
    task,
    capabilities,
    quota,
    repository: { path: inspection.path, identity: inspection.identity, baseRevision: inspection.revision },
    typesafeKey: process.env.TYPESAFE_API_KEY ?? null,
    typesafeConsent: args.flags.has("consent"),
    offline: false,
  });
  if (!routed.plan.profileId) {
    await server.close();
    output(args, routed);
    return;
  }
  const confirmed = args.flags.has("confirm-route")
    ? confirmPlan(routed.plan, routed.plan.profileId)
    : routed.plan;
  if (confirmed.status !== "confirmed") {
    await server.close();
    output(args, { ...routed, plan: confirmed, note: "re-run with --confirm-route after reviewing the plan" });
    return;
  }
  try {
    await executeConfirmedRun({ args, server, home, task, plan: confirmed, inspection, quota });
  } finally {
    await server.close();
  }
};

const basic = async (args: Args): Promise<void> => {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("Basic mode requires TYPESAFE_API_KEY; it never falls back to a non-Jev route.");
  const repo = resolve(value(args, "repo", process.cwd()) as string);
  const home = assertHomeOutsideRepo(homeFor(args), repo);
  const task = taskFor(args);
  const executable = resolveExecutable("codex");
  if (!executable) throw new Error("native codex.exe is unavailable");
  const server = CodexAppServer.start({ executable, cwd: repo });
  try {
    await server.initialize();
    const account = await server.account();
    if (!account.auth.managedLogin) {
      throw new Error("Basic mode requires managed ChatGPT authentication; no account switch or API fallback is attempted");
    }
    const capabilities = await server.models();
    let quota: ReturnType<typeof normalizeQuotaResponse> | null = null;
    let quotaReadError: string | null = null;
    try {
      quota = normalizeQuotaResponse(await server.rateLimits(), account.auth);
      writeSetupArtifacts({ home, repo, authentication: account.auth, capabilities, quota });
    } catch (error) {
      quotaReadError = String(error);
    }
    const config = basicConfig(capabilities, quota);
    const inspection = await inspectGit(repo);
    const routed = await routeTask({
      config,
      task,
      capabilities,
      quota,
      repository: { path: inspection.path, identity: inspection.identity, baseRevision: inspection.revision },
      typesafeKey: key,
      typesafeConsent: true,
      allowObservedPoolSet: true,
      skipQuotaEligibility: true,
    });
    if (routed.plan.routeSource !== "typesafe") {
      throw new Error("Jev did not produce a route: " + (routed.errors.join("; ") || "unknown failure"));
    }
    if (!routed.plan.profileId || !args.flags.has("confirm-route")) {
      output(args, {
        ...routed,
        quotaReadError,
        note: routed.plan.profileId
          ? "Jev route is ready. Re-run with --confirm-route --allow-live only after reviewing it."
          : "Jev deferred or requested more information; no worker was started.",
      });
      return;
    }
    if (!liveWorkerAllowed(args)) {
      output(args, {
        ...routed,
        quotaReadError,
        note: "Jev route is ready, but live execution remains blocked until --allow-live and CODEX_ORCHESTRATOR_CONFIRM_LIVE=I_AUTHORIZE are supplied.",
      });
      return;
    }
    if (!quota) {
      output(args, {
        ...routed,
        quotaReadError,
        note: "Jev route is ready, but worker execution is blocked because quota metadata could not be read.",
      });
      return;
    }
    const executionQuota = quotaDecision(
      config.profiles[0],
      config,
      quota,
      capabilities,
      Date.now(),
      { allowObservedPoolSet: true },
    );
    if (!executionQuota.eligible) {
      output(args, {
        ...routed,
        quotaReadError,
        executionQuota,
        note: "Jev route is ready, but worker execution is blocked by the current quota gate.",
      });
      return;
    }
    const confirmed = confirmPlan(routed.plan, routed.plan.profileId);
    await executeConfirmedRun({ args, server, home, task, plan: confirmed, inspection, quota });
  } finally {
    await server.close();
  }
};

const main = async (argv = process.argv.slice(2)): Promise<void> => {
  const args = parseArgs(argv);
  if (args.command === "doctor") return void (await doctor(args));
  if (args.command === "profiles") return profiles(args);
  if (args.command === "quota") return quota(args);
  if (args.command === "route") return route(args);
  if (args.command === "init") return init(args);
  if (args.command === "setup") return setup(args);
  if (args.command === "basic") return basic(args);
  if (args.command === "run") return runLive(args);
  if (args.command === "status") {
    const store = new RunStore({ home: homeFor(args) });
    output(args, store.status(value(args, "run") as string));
    return;
  }
  if (args.command === "accept") {
    const store = new RunStore({ home: homeFor(args) });
    output(args, await store.accept(value(args, "run") as string));
    return;
  }
  if (args.command === "reject") {
    const store = new RunStore({ home: homeFor(args) });
    output(args, await store.reject(value(args, "run") as string, value(args, "reason", "") as string));
    return;
  }
  if (args.command === "report") {
    const store = new RunStore({ home: homeFor(args) });
    output(args, reportRuns(store.list()));
    return;
  }
  throw new Error("usage: basic | doctor | init | setup | profiles | quota | route | run | status | accept | reject | report");
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { main, parseArgs };
