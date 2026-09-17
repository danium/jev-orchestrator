# Jev Orchestrator Codex plugin

This plugin bundles the Jev Orchestrator skill and runtime. The first runtime
command is setup --repo, which caches sanitized account/model/quota metadata
and creates disabled local drafts without starting a coding turn.

The runtime is in runtime/. It uses the installed Codex App Server schema
snapshot and has no runtime npm dependencies.
