# Jev Orchestrator runtime

This local runtime routes bounded development tasks to a
ChatGPT-authenticated Codex App Server worker after deterministic eligibility
and explicit confirmation.

It uses Node 22.6+ with built-in TypeScript type stripping and has no runtime
npm dependencies.

## Offline checks

    npm test
    $env:TYPESAFE_API_KEY = "your-typesafe-key"
    npm start -- basic --repo C:\path\to\checkout --objective "Describe the bounded task" --json

The tests use temporary repositories, mocked Jev responses, a fake App Server,
and fake workers. They do not use model allowance.

basic writes sanitized capabilities.json, quota.json, and account.json under
%LOCALAPPDATA%\CodexQuotaOrchestrator, then calls Jev on every route. It
creates profiles.json and the project verification draft only when they do not
already exist. It never uses a non-Jev fallback, enables advanced profiles,
claims a model-to-pool mapping, changes global Codex settings, or starts a
coding turn without explicit confirmation.

setup remains available for advanced configuration and uses the same metadata
cache without calling Jev.

## Live boundaries

Native App Server metadata, sandboxed commands, live Jev routing, and real
workers require separate explicit authorization. The run command additionally
requires --allow-live and CODEX_ORCHESTRATOR_CONFIRM_LIVE=I_AUTHORIZE.

Records default to %LOCALAPPDATA%\CodexQuotaOrchestrator. They remain outside
the worker checkout.
