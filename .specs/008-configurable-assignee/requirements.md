# Requirements — 008 Configurable Assignee

## Goal

Gate every human-facing assignee surface behind a root `enableAssignee`
config flag (default `false`) while leaving store records, persistence, and
raw JSON payloads untouched.

## Requirements

- R1: Root config `enableAssignee: boolean`, default `false`, loaded once at
  extension registration. Unknown/invalid values follow the existing
  per-field warning + safe-fallback pattern (`false` on invalid).
  Existing `maxAttempts`/glyph behavior is preserved.
- R2: When `false` (default), the injected `<task-management>` prompt block
  contains no assignee/owner guidance: `owners` is removed from the common
  Initial Materialization wording and no Assignment section is injected.
- R3: When `false`, `task_create` and `task_update` parameter schemas omit
  `assignee` entirely; `additionalProperties` remains `false`.
- R4: When `false`, the widget, `/tasks` viewer/detail UI, and
  human-oriented tool rendering hide assignee and reserve no assignee
  column or width.
- R5: When `true`, current behavior is preserved: `create assignee?:
  string`, `update assignee?: string|null`, prompt guidance (owners wording
  plus Assignment section), and widget/viewer/tool-rendering display and
  alignment.
- R6: The Assignment prompt (enabled only) is concise: use `assignee` only
  when the intended owner/agent type is known; it records ownership only
  and does not dispatch/start/authorize execution; do not invent it; `null`
  removes an existing assignment.
- R7: Persisted assignee data and store read/write compatibility remain
  intact: nothing is deleted or rewritten solely due to config, and the
  machine-readable raw JSON task payloads may continue to include persisted
  assignee data when `false`. The hiding scope is exactly prompt, input
  schemas, widget, viewer, and human-oriented tool rendering.
- R8: No separate schema factory functions: module-level common property
  objects + registration-time conditional object spread after config load.
  Typing stays clean without `any` where reasonably possible.
- R9: The task-management prompt is generated at registration with a
  conditional assignee section; duplicate-block protection and
  selectedTools gating are retained.
- R10: Config docs/README example and assignee behavior docs are updated.
- R11: `.specs/008-configurable-assignee/` artifacts follow the existing
  SDD convention (requirements, spec, design, tasks, verification).
- R12: Automated tests cover default `false`, `true`, invalid
  fallback/warning; `false`/`true` create/update schemas; `false` prompt
  without owner/assignee guidance vs `true` prompt with Assignment
  guidance; `false` widget/viewer/tool-rendering hiding without reserved
  alignment vs `true` preserving current display; persisted data surviving
  disabled mode and reappearing when enabled. Existing tests are updated
  intentionally for the new default without weakening unrelated coverage.
- R13: No store-level assignee compatibility or unrelated lifecycle change.
