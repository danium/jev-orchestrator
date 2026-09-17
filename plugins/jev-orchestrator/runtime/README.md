# Jev Orchestrator runtime

This local runtime routes bounded development tasks to a
ChatGPT-authenticated Codex App Server worker after deterministic eligibility
and explicit confirmation.

It uses Node 22.6+ with built-in TypeScript type stripping and has no runtime
npm dependencies.

## Offline checks

    npm test
    npm start -- doctor --repo C:\path\to\checkout --json
    npm start -- route --repo C:\path\to\checkout --task-file task.json --offline --json

The tests use temporary repositories, mocked Jev responses, a fake App Server,
and fake workers. They do not use model allowance.

## Live boundaries

Native App Server metadata, sandboxed commands, live Jev routing, and real
workers require separate explicit authorization. The run command additionally
requires --allow-live and CODEX_ORCHESTRATOR_CONFIRM_LIVE=I_AUTHORIZE.

Records default to %LOCALAPPDATA%\CodexQuotaOrchestrator. They remain outside
the worker checkout.
