# Jev Orchestrator

Jev Orchestrator is a local, Windows-first Codex plugin for bounded
development tasks. It keeps profile capability, quota eligibility, Jev routing,
worker execution, verification, and human acceptance separate.

It is not a quota bypass, does not promise savings, does not use an OpenAI API
key as a worker fallback, and does not run a real worker without explicit
authorization. Basic mode always routes through Jev with TYPESAFE_API_KEY.

## What the plugin provides

- A Codex skill for safe route planning and operation.
- A bundled Node runtime with JSON/JSONL records and a generated App Server
  protocol snapshot.
- Explicit model-effort-permission profile IDs and account-specific quota
  bindings.
- Windows-safe executable resolution, structured arguments, scoped sandbox
  requests, workspace locks, frozen verification, and accept/reject records.

## Install from this public repository

Clone the repository and run its installer:

    git clone https://github.com/danium/jev-orchestrator
    & C:\path\to\jev-orchestrator\scripts\install.ps1

Start a new Codex thread after installing so the skill is discovered.

## Setup a project

From plugins/jev-orchestrator/runtime:

    npm test
    $env:TYPESAFE_API_KEY = "your-typesafe-key"
    npm start -- basic --repo C:\path\to\checkout --objective "Describe the bounded task" --json

basic discovers and caches account/model/quota metadata automatically, then
always asks Jev to select the current Codex default or abstain. It does not
fall back to a non-Jev route. A missing or failed Jev key blocks the route.

setup remains available for advanced configuration: explicit profile choice,
verified quota-pool bindings, and frozen checks.

## Status

The bundled runtime has only passed offline tests: temporary repositories,
fake App Server JSONL, mocked Jev responses, and fake workers. Native account
metadata, real sandbox commands, live Jev, and real worker execution remain
opt-in compatibility gates.
