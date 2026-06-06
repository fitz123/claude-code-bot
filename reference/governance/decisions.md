# Architectural Decision Records

Track architectural decisions so future sessions know what was decided and why.

## Decisions

### ADR-081: Control Workspace, Agent Workspaces, And Guard Retirement

- Status: accepted
- Date: 2026-06-06
- Context: Issue #148 / PR #151 introduced the package CLI workspace contract, but the final runtime topology needs to separate the bot's control workspace from per-agent workspaces and remove schema/write-guard assumptions from the package contract.
- Decision: `--workspace` and `MINIME_WORKSPACE_ROOT` identify the control/app workspace that owns config, crons, bindings, runtime state, and global secret references. `agents.*.workspaceCwd` identifies each agent workspace; relative values resolve under the control workspace for compatibility, and absolute values may point outside the control workspace after existence/directory validation. Telegram, Discord, and Tavily secrets are global control-workspace secret references. `schema.md`, `MINIME_SCHEMA_PATH`, `PI_GUARD_WORKSPACE_ROOT`, Pi `guardian-protect-files`, write-allowlist parsing, and schema validation are retired from the bot package contract.
- Consequences: ADR-081 supersedes ADR-073 and ADR-080 clauses that made schema/write-guard infrastructure part of runtime/package correctness. Current public guidance must not describe agent workspaces as required to stay inside the control workspace except as explicitly legacy/deferred behavior. Private production deployment of guard-retired code requires explicit operator sign-off and cleanup of obsolete schema/guard hooks, imports, and prose before restart.
