# Specification — Task Tool Rendering

> All `task_delete` clauses are superseded by
> `.specs/005-deleted-task-status/spec.md`; current rendering covers four tools.

The exact user-facing strings in this section are authoritative. Do not
paraphrase them; tests MUST assert them verbatim (modulo sanitized values,
IDs, counts, and truncation).

## Notation

- `N task(s)` is notation only: emitted output MUST substitute singular/plural
  (`1 task` vs `N tasks`, where N ≠ 1, including 0 e.g. `0 tasks`). Emitted
  output MUST NEVER contain the literal string `task(s)`.
- `…` in `renderCall` strings is the single ellipsis character U+2026.

## Behavior

- S1: Each of `task_create`, `task_update`, `task_get`, `task_list`, `task_delete` provides a two-level display via `renderResult`: collapsed one-line summary + expanded detail block. Pending `renderCall` behavior is defined by S10 (count-free labels under S10, superseding any counted/filtered call forms).
- S2 (create): Collapsed line is `✓ Created N task(s)` (N = number created; singular/plural substituted). Expanded block lists one `#id title` row per created task.
- S3 (update): Collapsed line is `✓ Updated N task(s)` (singular/plural substituted). Expanded block shows one row per updated task: `#id final subject → changed fields`.
  - S3a: Changed fields are actual semantic diffs computed from pre-update snapshots vs. final state: only fields whose effective value changed are listed. Derived lifecycle/timing fields are excluded from the diff and MUST NOT mark an update as changed.
  - S3b: Changed-field order is fixed, exactly: `status, subject, description, assignee, dependencies, metadata, log`.
  - S3c: Input alias `blockedBy` maps to displayed `dependencies`; `appendLog` maps to displayed `log`.
  - S3d: When no effective change occurred, the row is `#id final subject → no changes`.
- S4 (get): Collapsed line is exactly `✓ Retrieved task #N`. Expanded block is the core operational view: title, status, description, assignee, dependencies, attempts, latest 3 logs. It omits metadata and timestamps. Description and log entries use bounded previews.
  - S4a: Latest 3 logs means the last three entries, displayed preserving chronological order among the selected three.
  - S4b: Absent assignee, absent dependencies, or absent recent log displays `—`.
  - S4c: Attempts displays `current/max` when a max exists, otherwise `current/unlimited`.
- S5 (list): Collapsed line is `✓ Listed N task(s)` (singular/plural substituted) with ` · status: X` appended when a status filter is active. Expanded block shows one `#id title → status` row per task in the tool's existing sort order; the active filter does not reorder beyond the tool's own sorting. An empty result is a non-error empty state whose collapsed line is `○ No tasks[...]` (filter context appended when a filter is active, e.g. `○ No tasks · status: X`); it MUST NOT use any `✗ Failed to ...` error form.
- S6 (delete): Collapsed line is exactly `✓ Deleted task #N`. The expanded block shows the pre-delete subject only on success (captured pre-delete `{id,subject}`); on failure no title is shown.
- S7 (errors): Collapsed line MUST be exactly one of:
  - `✗ Failed to create tasks`
  - `✗ Failed to update tasks`
  - `✗ Failed to retrieve task #N` (N from args)
  - `✗ Failed to list tasks`
  - `✗ Failed to delete task #N` (N from args)
  The expanded detail contains sanitized expected-error detail for known failures (e.g. not-found, validation) and a masked generic message for unexpected/internal failures. Generic forms such as `task_update failed` MUST NOT be used.
- S8: All rendered text is sanitized: control characters neutralized, lines truncated to a safe terminal width. Sanitization applies to titles, descriptions, logs, and expected-error detail.
- S9: No progress callbacks or streaming output are emitted by any of the five tools. Pending `renderCall` behavior is defined by S10; settled `renderCall` is the zero-height `Container` per S12.

## Refinement — Themed Spinner `renderCall` and Settled Output Themes (approved)

- S10: During normal interactive pre-execution pending (`isPartial === true && executionStarted !== true`), `renderCall` MUST show an animated spinner when `toolCallId` is stable, or the same static safe label when it is not, with exactly these count-free generic labels (single ellipsis U+2026; no IDs, counts, or filters in the loading label). Pending styling MUST be: spinner frame (`⠋` etc.) in theme `accent`, pending label in theme `toolTitle`, threaded from each tool's `renderCall` host theme into the shared spinner/helper with ANSI-aware width safety (truncate the plain label first; themed ANSI adds no visible width) and theme refresh on reuse. Plain/no-theme/theme-throw fallbacks MUST keep the exact unstyled pending string and animation behavior. Once execution has started, these labels remain visible only by continuing/recovering a spinner created during that pre-execution phase; export/replay with no prior spinner renders no call rows:
  - create: `Creating tasks…`
  - update: `Updating tasks…`
  - get: `Retrieving task…`
  - list: `Listing tasks…`
  - delete: `Deleting task…`
  This refinement is the authoritative pending `renderCall` contract except as qualified above; S1–S9 settled strings, model JSON/error/schema invariants, collapsed/expanded behavior, sanitization, and width limits are otherwise unchanged.
- S11: On settled success, theming MUST be: `✓` glyph in theme `success` (green); success summary text (`Created N task(s)` substituted, `Updated N task(s)` substituted, `Retrieved task #N`, `Listed N task(s)[ · status: X]` substituted, `Deleted task #N`) in theme `toolTitle`; every expanded detail line in theme `toolOutput`, matching normal host tool output. Error/empty semantics MUST stay readable and consistent: theme `error` for the failure glyph/summary, theme `dim` for the empty `○` indicator, and detail text in `toolOutput` unless safety requires otherwise. Non-themed/fallback modes MUST preserve the existing plain semantic strings verbatim.
- S12: Spinner lifecycle MUST be precisely: create a spinner only during `isPartial === true && executionStarted !== true` when a stable `toolCallId` is available; otherwise use the static safe fallback. Reuse one spinner component/timer through context and the `toolCallId` registry and call `context.invalidate` to advance frames. During `isPartial === true && executionStarted === true`, continue/recover an existing registered, `lastComponent`, or shared-state spinner, but if none exists return an empty `Container` without creating a timer or registry entry. This makes Pi 0.85.1 HTML export/replay—whose first call render is already execution-started—emit no loading HTML. On `isPartial === false`, stop every recoverable spinner, clear registry/state, and return the same zero-height `Container`, never the loading label. `renderResult` retains defensive cleanup. No progress callbacks/`onUpdate`; no lingering timer after settlement or export. Host default shell/background remains unchanged (`renderShell` is not self).

## Inputs

- Tool arguments and results for the five task tools, as currently shaped (unchanged).
- Pre-update task snapshots (for S3 semantic diffs) and pre-delete `{id,subject}` (for S6 success rendering), captured in `src/index.ts` handler/result-helper integration.
- Known/expected error kinds (e.g. not-found, validation) vs. unexpected/internal errors.

## Outputs

- Human-facing collapsed + expanded terminal strings per tool outcome, using the exact strings above.
- Model-facing JSON and error text: unchanged (see Invariants).

## Errors

- E1: Expected errors → exact S7 collapsed line for the operation + sanitized detail.
- E2: Unexpected errors → exact S7 collapsed line for the operation + masked generic detail (no internals).
- E3: Renderer-internal failure → fall back to prior/plain display; MUST NOT alter model output or throw to the model path.

## Edge Cases

- Empty list result → `○ No tasks[...]` non-error empty state with count 0.
- Update with only aliased keys and no effective change, or only derived lifecycle/timing differences → `no changes`.
- Missing/empty subject on delete failure → ID-only summary, no title.
- Over-wide text, newlines, tabs, ANSI/control characters → truncated/neutralized.
- Missing optional fields: assignee/dependencies/recent log render `—` (S4b); other missing optionals (e.g. description) → omitted or shown as empty, never error.

## Invariants

- I1: Tool schemas byte-for-byte unchanged.
- I2: Model-facing JSON/error text byte-for-byte unchanged.
- I3: Only two display levels via `renderResult`; no progress callbacks/streaming; no widget/`/tasks` UI changes.

## Acceptance Criteria

- A1: `task_create` renders `✓ Created N task(s)` (substituted) + ID/title rows; model JSON unchanged. (covers S2; pending/settled call behavior is covered by A9/A11)
- A2: `task_update` renders `✓ Updated N task(s)` + `#id final subject → changed fields` with snapshot-based semantic diffs in the exact fixed order, alias mapping, derived-field exclusion, and `→ no changes`. (covers S3; call behavior is covered by A9/A11)
- A3: `task_get` renders `✓ Retrieved task #N` with the core operational view: latest 3 logs in chronological order, `—` for absent assignee/dependencies/log, `current/max` or `current/unlimited` attempts, bounded previews, no metadata/timestamps. (covers S4; call behavior is covered by A9/A11)
- A4: `task_list` renders `✓ Listed N task(s)[ · status: X]` + `#id title → status` rows in tool sort order, and `○ No tasks[...]` non-error empty state. (covers S5; call behavior is covered by A9/A11)
- A5: `task_delete` renders `✓ Deleted task #N`; pre-delete subject appears only on success. (covers S6; call behavior is covered by A9/A11)
- A6: Errors render exactly the five S7 `✗ Failed to ...` lines (with N from args where applicable); expected detail sanitized, unexpected masked; generic `task_* failed` forms absent. (covers S7)
- A7: Width/control-character handling is safe; no progress callbacks/streaming. (covers S8, S9; pending/settled call behavior is covered by A9/A11)
- A8: Schemas and model-facing JSON/error text unchanged. (covers I1, I2)
- A9: During normal pre-execution pending, `renderCall` creates an animated spinner for a stable `toolCallId` with exactly the count-free generic labels `Creating tasks…`, `Updating tasks…`, `Retrieving task…`, `Listing tasks…`, `Deleting task…`, with no IDs, counts, or filters; without a stable ID it safely shows the static label. Interactive execution-started renders continue that existing spinner. (covers S10)
- A10: On settled success, `✓` uses theme `success`, the success summary text uses theme `toolTitle`, and every expanded detail line uses theme `toolOutput`, matching normal host tool output; failures use theme `error` for glyph/summary, empty state uses theme `dim` for the `○` indicator, detail text uses `toolOutput` unless safety requires otherwise, and non-themed/fallback modes preserve the plain semantic strings. (covers S11)
- A11: A spinner is created only before execution, then reused/recovered while execution remains partial and advanced via `context.invalidate`. An execution-started call with no prior spinner returns a zero-line empty `Container` and creates no timer/registry state, so completed and result-less HTML exports contain no loading label or spinner frame. Settlement clears all recoverable state/timers and also returns the empty component; interactive host composition still shows the themed result for all five tools. No progress callbacks/`onUpdate`; host default shell/background remains unchanged. (covers S12)
