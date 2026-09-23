# Requirements — Task Tool Rendering

> The `task_delete` requirements in this historical feature are superseded by
> `.specs/005-deleted-task-status/spec.md`; current rendering covers four tools.

## Goal

Provide custom, minimal terminal rendering for the five task tools
(`task_create`, `task_update`, `task_get`, `task_list`, `task_delete`)
so human operators get a readable two-level collapsed/expanded display,
while model-facing JSON and error text plus tool schemas remain byte-for-byte unchanged.

## Functional Requirements

- R1: Collapsed/expanded terminal display MUST be provided for all five task tools via `renderResult`; `renderCall` MUST follow the count-free pending and zero-height settled behavior in R10/R12 and MUST NOT use progress callbacks.
- R2: `task_create` MUST show `✓ Created N task(s)` (singular/plural substituted, never literal `task(s)`) plus ID/title rows.
- R3: `task_update` MUST show `✓ Updated N task(s)` plus `#id final subject → changed fields`, using actual semantic diffs in fixed order `status, subject, description, assignee, dependencies, metadata, log`, with aliases `blockedBy→dependencies` and `appendLog→log`, and `no changes` for no-ops (derived lifecycle/timing fields excluded from the diff).
- R4: `task_get` MUST show `✓ Retrieved task #N` plus the core operational view (title, status, description, assignee, dependencies, attempts as `current/max` or `current/unlimited`, latest 3 logs in chronological order among the selected last three); absent assignee/dependencies/recent log displays `—`; omit metadata/timestamps; use bounded description/log previews.
- R5: `task_list` MUST show `✓ Listed N task(s)[ · status: X]` plus `#id title → status` rows, honoring sorting/filtering, with non-error empty state `○ No tasks[...]`.
- R6: `task_delete` MUST show `✓ Deleted task #N` and include the pre-delete subject only on success.
- R7: Errors MUST use exactly `✗ Failed to create tasks`, `✗ Failed to update tasks`, `✗ Failed to retrieve task #N`, `✗ Failed to list tasks`, `✗ Failed to delete task #N` (N from args where applicable); expected-error detail MUST be sanitized; unexpected errors MUST be masked.
- R8: Rendering MUST handle width limits and control characters safely.
- R9: No progress callbacks or streaming output.
- R10: Normal interactive calls MUST show an animated spinner with count-free generic labels (no IDs, counts, or filters): `Creating tasks…`, `Updating tasks…`, `Retrieving task…`, `Listing tasks…`, `Deleting task…`; the spinner frame MUST use theme `accent` and the pending label MUST use theme `toolTitle`, threaded from all five `renderCall` registrations into the shared spinner/helper with ANSI-aware width safety and theme refresh on reuse; plain/no-theme/theme-throw fallbacks MUST keep the exact unstyled pending string and animation; export/replay without a pre-execution render MUST omit the loading row per R12.
- R11: On settled success, the `✓` glyph MUST use theme `success`, the success summary text MUST use theme `toolTitle`, and every expanded detail line MUST use theme `toolOutput`, matching normal host tool output. Failure MUST use theme `error` for glyph/summary; empty state MUST use theme `dim` for the `○` indicator; detail text MUST use `toolOutput` unless safety requires otherwise. Plain semantic strings MUST be preserved for non-themed/fallback modes.
- R12: During normal interactive pre-execution pending (`isPartial === true && executionStarted !== true`), create and animate one spinner when `toolCallId` is stable, reuse it across renders, advance frames via `context.invalidate`, and use a static safe fallback when no stable ID is available. After `executionStarted === true`, continue/recover an existing registry/last/state spinner, but never create one; if none exists (as in HTML export/replay), return a documented zero-height empty component with no timer or registry state. When `isPartial === false`, stop every recoverable spinner, clear state/registry, and return the same empty component so only `renderResult` remains; defensive result-side cleanup remains required. It MUST NOT use progress callbacks/`onUpdate`. Host default shell/background remains unchanged (`renderShell` is not self).

## Non-Functional Requirements

- N1: Human-readable output stays minimal (two levels only).
- N2: Rendering failures MUST never break model-facing output.
- N3: Keep implementation minimal and focused (`src/tool-rendering.ts`, minimal `src/index.ts` integration, focused tests).

## Constraints

- C1: Model-facing JSON/error text and tool schemas MUST remain byte-for-byte identical. Integration in `src/index.ts` is presentation-only (`details`), plus capturing pre-update snapshots and pre-delete `{id,subject}` for successful rendering.
- C2: Widget and `/tasks` UI are out of scope.

## Non-Goals

- Changes to tool schemas, model JSON, or error strings.
- Progress callbacks or streaming.
- Widget or `/tasks` UI changes.
- Full task detail views (timestamps, full metadata, full log history).

## Assumptions

- Existing tool result/error shapes are the source of truth for rendering inputs.
- Sanitization means: strip control characters, bound length, never leak unexpected internals.
- Exact user-facing strings are authoritative as defined in `spec.md`, including singular/plural substitution (emitted output never contains literal `task(s)`).

## Unresolved Questions

- None; plan taken as approved in the assigning conversation.
