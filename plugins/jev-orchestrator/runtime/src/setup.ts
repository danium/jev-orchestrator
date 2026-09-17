import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  assertHomeOutsideRepo,
  writeJsonAtomic,
  type AppConfig,
  type AuthSnapshot,
  type ModelCapability,
} from "./contracts.ts";
import type { QuotaSnapshot } from "./quota.ts";

export const projectConfigDraft = () => ({
  schemaVersion: 1,
  templateOnly: true,
  workspaceMode: "dedicated-worktree",
  scope: { includedPaths: [], excludedPaths: [] },
  verification: { schemaVersion: 1, mode: "unconfigured", checks: [] },
  typesafeDisclosure: {
    approved: false,
    allowedFields: [
      "objective",
      "acceptanceCriteria",
      "scopeHints",
      "requiredAccess",
      "knownRisk",
      "verificationAvailability",
    ],
    sendSourceFiles: false,
    sendRawLogs: false,
  },
});

export const basicConfig = (
  capabilities: ModelCapability[],
  quota: QuotaSnapshot | null,
): AppConfig => {
  const model = capabilities.find((candidate) => candidate.isDefault);
  if (!model) throw new Error("installed model list did not identify a default model");
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
  const bindingId = "basic-observed-pools";
  config.profiles = [
    {
      id: "basic-current-default-implement",
      enabled: true,
      modelId: model.id,
      effort: { kind: "model-default" },
      speed: "standard",
      permissionClass: "implement",
      riskClasses: ["low", "material"],
      fits: "Basic mode uses the current Codex default for bounded low or material work. Jev may defer or ask for more information. Critical, destructive, and unverified work stay out of Basic mode.",
      status: "candidate",
      quotaBindingId: bindingId,
    },
  ];
  config.quotaBindings = [
    {
      id: bindingId,
      poolIds: quota?.pools.map((pool) => pool.id) ?? [],
      modelIds: [model.id],
      evidence: "unknown",
      note: "Basic mode routes through Jev before quota admission. It does not claim a verified model-to-pool mapping.",
    },
  ];
  return config;
};

export type SetupResult = {
  home: string;
  repo: string;
  created: string[];
  updated: string[];
  authentication: AuthSnapshot;
  capabilityCount: number;
  quotaPoolIds: string[];
  next: string[];
};

export const writeSetupArtifacts = (input: {
  home: string;
  repo: string;
  authentication: AuthSnapshot;
  capabilities: ModelCapability[];
  quota: QuotaSnapshot;
}): SetupResult => {
  const repo = resolve(input.repo);
  const home = assertHomeOutsideRepo(input.home, repo);
  const profilePath = join(home, "profiles.json");
  const projectPath = join(repo, ".codex-orchestrator.json");
  const capabilitiesPath = join(home, "capabilities.json");
  const quotaPath = join(home, "quota.json");
  const accountPath = join(home, "account.json");
  const created: string[] = [];
  const updated: string[] = [];

  if (!existsSync(profilePath)) {
    writeJsonAtomic(profilePath, DEFAULT_CONFIG);
    created.push(profilePath);
  }
  if (!existsSync(projectPath)) {
    writeJsonAtomic(projectPath, projectConfigDraft());
    created.push(projectPath);
  }

  writeJsonAtomic(capabilitiesPath, input.capabilities);
  writeJsonAtomic(quotaPath, input.quota);
  writeJsonAtomic(accountPath, input.authentication);
  updated.push(capabilitiesPath, quotaPath, accountPath);

  return {
    home,
    repo,
    created,
    updated,
    authentication: input.authentication,
    capabilityCount: input.capabilities.length,
    quotaPoolIds: input.quota.pools.map((pool) => pool.id),
    next: [
      "Review profiles.json. Every profile remains disabled until you explicitly enable it.",
      "Add only user-approved quota bindings; model names do not establish pool membership.",
      "Set meaningful verification checks in .codex-orchestrator.json before requesting a route.",
    ],
  };
};
