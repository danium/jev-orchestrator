# Jev Orchestrator

Jev Orchestrator is a local, Windows-first Codex plugin for bounded
development tasks. It keeps profile capability, quota eligibility, Jev routing,
worker execution, verification, and human acceptance separate.

It is not a quota bypass, does not promise savings, does not use an OpenAI API
key as a worker fallback, and does not run a real worker or a live Jev request
without explicit authorization.

## What the plugin provides

- A Codex skill for safe route planning and operation.
- A bundled Node runtime with JSON/JSONL records and a generated App Server
  protocol snapshot.
- Explicit model-effort-permission profile IDs and account-specific quota
  bindings.
- Windows-safe executable resolution, structured arguments, scoped sandbox
  requests, workspace locks, frozen verification, and accept/reject records.

## Install from this public repository

Clone the repository, then add its marketplace root to Codex:

    git clone https://github.com/danium/jev-orchestrator
    codex plugin marketplace add C:\path\to\jev-orchestrator
    codex plugin add jev-orchestrator@jev-orchestrator

Start a new Codex thread after installing so the skill is discovered.

## Runtime checks

From plugins/jev-orchestrator/runtime:

    npm test
    npm start -- doctor --repo C:\path\to\checkout --json
    npm start -- route --repo C:\path\to\checkout --task-file task.json --offline --json

Use the plugin skill for the staged workflow and safety gates. Read the
runtime README before enabling a profile or attempting a native/live check.

## Status

The bundled runtime has only passed offline tests: temporary repositories,
fake App Server JSONL, mocked Jev responses, and fake workers. Native account
metadata, real sandbox commands, live Jev, and real worker execution remain
opt-in compatibility gates.
