# Jev Orchestrator runtime

This local runtime routes bounded development tasks to a
ChatGPT-authenticated Codex App Server worker after deterministic eligibility
and explicit confirmation.

It uses Node 22.6+ with built-in TypeScript type stripping and has no runtime
npm dependencies.

## Offline checks

    npm test
    npm start -- setup --repo C:\path\to\checkout --json
    npm start -- route --repo C:\path\to\checkout --objective "Describe the bounded task" --offline --json

The tests use temporary repositories, mocked Jev responses, a fake App Server,
and fake workers. They do not use model allowance.

setup writes sanitized capabilities.json, quota.json, and account.json under
%LOCALAPPDATA%\CodexQuotaOrchestrator. It creates profiles.json and the
project verification draft only when they do not already exist. It never
enables profiles, infers quota-pool mappings, changes global Codex settings,
or starts a coding turn.

## Live boundaries

Native App Server metadata, sandboxed commands, live Jev routing, and real
workers require separate explicit authorization. The run command additionally
requires --allow-live and CODEX_ORCHESTRATOR_CONFIRM_LIVE=I_AUTHORIZE.

Records default to %LOCALAPPDATA%\CodexQuotaOrchestrator. They remain outside
the worker checkout.
