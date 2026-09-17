import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  assertHomeOutsideRepo,
  writeJsonAtomic,
  type AuthSnapshot,
  type ModelCapability,
} from "./contracts.ts";
import type { QuotaSnapshot } from "./quota.ts";

export const projectConfigDraft = () => ({
  schemaVersion: 1,
  templateOnly: true,
  workspaceMode: "dedicated-worktree",
  scope: { includedPaths: [], excludedPaths: [] },
  verification: { mode: "unconfigured", checks: [] },
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
