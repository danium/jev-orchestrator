# Jev Orchestrator Codex plugin

This plugin bundles the Jev Orchestrator skill and runtime. Basic mode is
Jev-first: it discovers metadata, calls Jev with TYPESAFE_API_KEY, and either
selects the current Codex default or abstains without starting a worker.

The runtime is in runtime/. It uses the installed Codex App Server schema
snapshot and has no runtime npm dependencies.
