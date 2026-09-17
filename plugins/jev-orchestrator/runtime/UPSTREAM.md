# Upstream attribution

This runtime is an additive adaptation of the reviewed lahfir/claude-plugins
baseline, distributed by the Jev Orchestrator plugin.

- Baseline: 724676aa026820dc4e79466d0cc715feae2e0d5d
- Reused ideas: the typed choice request and candidate/rubric separation from delegate/scripts/delegate.mjs, plus the focused fixture style from delegate/scripts/delegate.test.mjs.
- Substantive changes: unique execution-profile IDs, deterministic eligibility, structural Jev validation, subscription/quota policy, generated Codex App Server protocol usage, Windows-safe process handling, workspace ownership, verification, journaling, and reporting.
- Not reused: Claude launch strings, shell interpolation, fixed reviewer assumptions, and the legacy harness:model candidate key.

The existing delegate plugin remains independent and retains its MIT notice.
