# Design — Task Tool Rendering

> Delete-renderer design is superseded by
> `.specs/005-deleted-task-status/spec.md`; `task_delete` is no longer registered.

## Overview

Add a single focused rendering module, `src/tool-rendering.ts`, with pure
per-tool format functions emitting the exact authoritative strings from
`spec.md` (including singular/plural substitution, `→` list rows, and the
five exact `✗ Failed to ...` error lines), wired
via minimal handler/result-helper integration in `src/index.ts`. Rendering
affects only the human-facing terminal channel (`renderResult`
collapsed/expanded; `renderCall` pending/spinner behavior per S10–S12/D6); the model
channel (content, schemas, error text) passes through untouched. The refined
`renderCall` lifecycle is defined by D6. Focused tests assert the exact strings.

Satisfies: R1–R9; S1–S9; A1–A8.

Refinement satisfies: R10–R12; S10–S12; A9–A11 (see D6).

## Components

### `src/tool-rendering.ts` (new)

- Responsibility: pure formatting only — no I/O, no schema changes, no model-output mutation.
- Functions (one per tool outcome + shared helpers):
  - `renderTaskCreate`, `renderTaskUpdate`, `renderTaskGet`, `renderTaskList`, `renderTaskDelete`
  - `renderTaskToolError(operation, error)` — exactly the five S7 lines (`✗ Failed to create tasks`, `✗ Failed to update tasks`, `✗ Failed to retrieve task #N`, `✗ Failed to list tasks`, `✗ Failed to delete task #N`) + sanitized expected detail or masked unexpected detail
  - Helpers: `sanitizeText`, `truncateToWidth`, `boundedPreview`, `semanticDiff(before, after)`, `pluralizeTask(count)`
- Dependencies: task result/error types only (read-only).

### `src/index.ts` (minimal handler/result-helper integration)

- Responsibility:
  - Attach the corresponding render function as presentation-only `details` for each of the five tool registrations: `renderResult` collapsed/expanded plus the D6 count-free pending and zero-height settled `renderCall`. No progress callbacks.
  - Capture pre-update task snapshots before mutation so `semanticDiff` compares effective before/after values.
  - Capture pre-delete `{id,subject}` before deletion and pass it to the delete renderer only for the success path (`✓ Deleted task #N` + subject); failure path renders ID-only with `✗ Failed to delete task #N`.
- No change to tool names, schemas, handler return values, or model/error text.

### Focused tests (new, colocated per repo convention)

- Responsibility: assert the exact collapsed strings (substituted singular/plural, never literal `task(s)`), pending/settled `renderCall` behavior per S10–S12, `#id title → status` list rows, get semantics (latest 3 logs chronological, `—` placeholders, `current/max` vs `current/unlimited`), diff order/aliases/`no changes`, delete title-on-success-only, the five exact error lines, width/control-char safety, and model-output passthrough.

## Data Flow

```text
tool handler result/error (+ captured pre-update snapshot / pre-delete {id,subject})
  → model channel (unchanged passthrough: content, schema, error text)
  → tool-rendering.ts format fn → presentation-only `details`
      → renderResult: collapsed line + expanded block
      → renderCall: pending spinner labels / executions-started / settled behavior (per S10–S12)
```

Renderer failure → catch and fall back to plain display (E3); model path unaffected.

## Interfaces

```ts
// Illustrative; exact types follow existing result/error shapes.
// Collapsed/renderCall strings MUST equal the authoritative spec.md literals
// after singular/plural substitution (never emit literal "task(s)").
type CollapsedExpanded = { collapsed: string; expanded: string };
function renderTaskCreate(result: TaskCreateResult): CollapsedExpanded;
function renderTaskUpdate(before: Task, after: Task, input: UpdateInput): CollapsedExpanded;
function renderTaskGet(task: Task): CollapsedExpanded;
function renderTaskList(tasks: Task[], filter?: string): CollapsedExpanded;
function renderTaskDelete(id: string, preDeleteSubject?: string, ok: boolean): CollapsedExpanded;
function renderTaskToolError(operation: TaskOperation, err: unknown): CollapsedExpanded;
```

## Decisions

### D1. Single module `src/tool-rendering.ts`

Keeps human formatting isolated and reviewable; avoids scattering display logic across handlers. Satisfies N3, I1, I2.

### D2. Pure functions + minimal `src/index.ts` presentation integration

Formatting is isolated and unit-testable; `src/index.ts` attaches presentation-only `details` and the D6 `renderCall`, captures pre-update snapshots for semantic diffs, and captures pre-delete `{id,subject}` for the success path. Model content, schemas, and error text are preserved byte-for-byte. Satisfies C1, E3.

### D3. Snapshot-based semantic diff with fixed field order and alias normalization

`semanticDiff` compares captured pre-update snapshots vs. final state (not raw input keys), excludes derived lifecycle/timing fields, emits only changed fields in exactly `status, subject, description, assignee, dependencies, metadata, log`, normalizing `blockedBy→dependencies` and `appendLog→log`; empty diff → `no changes`. Satisfies S3, A2.

### D4. Sanitize-then-truncate helper chain with safe expected/unexpected errors

All human text passes through control-character neutralization then width-bounded truncation/previews. Get view renders `—` for absent assignee/dependencies/log, attempts as `current/max` or `current/unlimited`, and the last three logs in chronological order. Expected errors reuse the same chain for sanitized detail; unexpected errors are replaced by a masked generic message under the exact S7 `✗ Failed to ...` line. Satisfies S4, S7, S8, A3, A6, A7.

### D5. `renderResult` collapsed/expanded only; no progress callbacks

No progress callbacks, incremental result updates, or streaming output; each tool returns exactly one collapsed + one expanded payload via `renderResult`. Pending/settled `renderCall` behavior is D6. List rows use `#id title → status`. Satisfies S1, S5, S9, I3.

### D6. Themed spinner `renderCall` + settled output themes (refinement)

- `renderCall` uses one shared spinner component driven by the render context: count-free generic labels per S10 (`Creating tasks…`, `Updating tasks…`, `Retrieving task…`, `Listing tasks…`, `Deleting task…`); partial args (counts, IDs, filters) MUST NOT appear in the loading label. The host theme is threaded from all five `renderCall` registrations into the shared spinner/helper: spinner frame in theme `accent`, pending label (animated and static fallback) in theme `toolTitle`, with ANSI-aware width safety (truncate the plain label before theming; `Text` wraps ANSI-aware) and theme refresh on every reused update; plain/no-theme/theme-throw fallbacks keep the exact unstyled pending string and animation.
- Settled success applies host theme keys per S11: glyph `success`, summary `toolTitle`, every detail line `toolOutput`; failure glyph/summary `error`; empty `○` indicator `dim`; detail text `toolOutput` unless safety requires otherwise; non-themed/fallback paths keep the existing plain semantic strings verbatim.
- Lifecycle per S12: create the spinner only during normal pre-execution pending (`isPartial === true && executionStarted !== true`) when `toolCallId` is stable; otherwise use the static safe fallback. After execution starts, reuse/recover only an existing registry/last/state spinner and return an empty `Container` if none exists. This distinction keeps `ToolExecutionComponent` animated because it always renders before execution starts, while Pi 0.85.1 HTML export/replay (first call render is `executionStarted: true`) emits no loading HTML or timer. Reuse one component/timer and advance frames with `context.invalidate`. On `isPartial === false`, stop all registry/component/state-recoverable spinners, clear registry/state, and return the empty `Container`. Pi documents `Container` as the zero-height empty component and composes interactive `renderCall` before `renderResult`, so settlement replaces the loading row with the result. Keep result-side defensive cleanup, no progress callbacks/`onUpdate`, and the default host shell (`renderShell` is not self). Satisfies R10–R12, S10–S12, A9–A11.

## Trade-offs

- Bounded previews (get description/logs) lose full fidelity in terminal view — accepted; model JSON retains full data.
- Masked unexpected errors reduce debuggability in human view — accepted for safety; detail remains in logs/model path as today.
- Pre-update snapshots / pre-delete `{id,subject}` add small reads in `src/index.ts` — accepted as the minimal state needed for accurate diffs and success titles.
