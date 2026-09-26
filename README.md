# pi-tasks

Local Pi extension for per-main-session task tracking.

## Configuration

Optional JSON file at `$PI_CODING_AGENT_DIR/extensions/pi-tasks.json`
(resolved as `join(getAgentDir(), "extensions", "pi-tasks.json")`), loaded once
when the extension registers:

```json
{
  "maxAttempts": 8,
  "enableAssignment": false,
  "injectGuidelines": true
}
```

- A missing file or missing fields fall back to the defaults above.
- `enableAssignment` (default `false`) gates assignment input, inline guideline
  wording, and assignment display. When enabled, create accepts an optional
  whole `assignment`; update accepts a whole replacement, `null` to remove, or
  omission to preserve. Direct assignment is `{ "delegate": false, "owner": null }`;
  delegated assignment is `{ "delegate": true, "owner": "<subagent type>" }`.
  Assignment is planning metadata only and never dispatches, starts, resumes,
  or authorizes execution. Delegated owners are opaque non-empty strings that
  pi-tasks preserves exactly; runtime discovery, availability validation, and
  agent selection belong to the subagent extension.
- `injectGuidelines` (default `true`) controls whether the extension appends
  the `<task-management>` policy block to the system prompt in
  `before_agent_start` while `task_create` is active; an existing block is
  left unchanged. When `false`, no system-prompt handler is registered and
  nothing is appended. Tool summary descriptions and the `task_create`
  `promptSnippet` are unchanged either way: the block carries the
  workflow/lifecycle policy (scope, materialization, lifecycle, rework,
  blocking), with inline `assignments` wording following `enableAssignment`.
  There is no standalone `## Assignment` section; assignment semantics live on the
  `assignment` schema descriptions.
  Non-boolean values warn and fall back to `true`.
- Malformed JSON or invalid values never crash startup: each problem is
  reported as a warning and only the offending value falls back to its
  default. `maxAttempts` must be a non-negative safe integer (0 means unlimited).
  Unknown keys are reported and ignored.
- `maxAttempts` is the per-task attempt cap applied to every task created by
  `task_create`. `task_create.tasks[]` items cannot set their own cap: a
  supplied `maxAttempts` is rejected.
  `0` means unlimited attempts: entry into `in_progress` always succeeds and
  keeps incrementing `attempt`, no final-attempt warning fires, and the
  remaining-attempts (`↻N`) indicator is hidden in the widget while the numeric
  `(<attempt>/<maxAttempts>)` counter is hidden in the `/tasks`
  list/detail views. `attempt` and `maxAttempts` stay present in
  JSON tool payloads. Non-integer, negative, or unsafe config values fall
  back with a warning;
  persisted tasks keep loading unchanged.

## Stores

One file per main session: `<cwd>/.pi/tasks/tasks-{sanitizedSessionId}.json`
with envelope `{ version: 2, nextId, tasks, history, totalActiveMs, activeSince? }`. `tasks` is the active
list; `history` is an append-only array of completed cycles containing their task snapshots, logs,
archive timestamp, and accumulated active time. Version-1 envelopes remain readable and upgrade on
their next successful write. Session IDs are encoded as a filename-safe readable prefix plus a
deterministic SHA-256 digest. IDs allocate monotonically from `nextId` and are never reused across
active or archived cycles. Writes are atomic (temp file + rename).

Timing state persists in the same envelope so reloads neither reset running
timers nor count idle gaps: each task carries `startedAt?` (start of the
current `in_progress` attempt) and `tookMs?` (frozen duration of the last
finished attempt); the envelope carries `totalActiveMs` (finished
wall-clock union time while at least one task was `in_progress`) and
`activeSince?` (start of the running period, if any). Reloading preserves
running values; legacy files without timing start counting from load time
(a legacy `in_progress` task without `startedAt` starts its attempt at the
load timestamp, matching the global `activeSince` load-time behavior)
and legacy completed tasks fall back to frozen `createdAt`→`updatedAt` spans.

Session lifecycle (`session_start`, resolved from `ctx.sessionManager.getSessionId()`
and the current cwd): fires on `startup`, `reload`, `resume`, `new`, and `fork`,
and immediately loads the current session's store to refresh the widget — or
clear it when the session has no tasks. Only the current session's file is
read, so `new`/`fork` sessions start with a cleared widget and never inherit
parent-session tasks. Load or refresh failures never throw and never delete or
reset the persisted file.

Turn lifecycle (`turn_start`, same `ctx.sessionManager.getSessionId()` + cwd
store): before refreshing the widget, atomically moves a non-empty terminal
active list (every task is `completed` or `deleted`) into `history`, then clears
active tasks and timing while preserving `nextId`. The next task therefore
continues the ID sequence. A list with any pending/in-progress/paused task is
left unchanged. `session_start` remains read-only, so terminal tasks stay active
and visible until the next turn starts. As a fallback when creation occurs
without a preceding turn-start archive, `task_create` archives the terminal
cycle and creates the new batch in the same atomic write. Failed validation or
persistence leaves the active terminal cycle untouched.

Note: concurrent writers across processes rely on the atomic rename but take
no interprocess lock; overlapping writes may lose one update (last rename
wins). This is a pre-existing limitation.

## Tools

Exactly four tools; no convenience, dependency, delete, or subagent tools. Field-specific
input contracts live on parameter descriptions, while each tool description is a short
summary starting with `Use this tool to`. Workflow/lifecycle policy lives in the
`<task-management>` block appended to the system prompt in `before_agent_start`
while `task_create` is active, gated by `injectGuidelines` (see Configuration).

- `task_create { tasks: [{ ref?, subject, description, blockedBy?, blockedByRefs?, reviewOf?, reviewOfRefs?, metadata? }, ...] }`
  creates one or more `pending` tasks atomically. `tasks` must be non-empty.
  When `enableAssignment` is `true`, each item additionally accepts an optional
  whole `assignment` object as described under Configuration.
  Optional request-local refs must match `^[a-z][a-z0-9_-]*$`; they may be
  referenced through `blockedByRefs`/`reviewOfRefs` in the same request and are never
  persisted. Duplicate, unknown, self-referential, or cyclic refs reject the
  full batch. Tasks receive numeric IDs in stable topological order, with
  original input order breaking ties between simultaneously-ready tasks.
  Numeric `blockedBy`/`reviewOf` may target existing tasks and may be mixed with local
  refs. `reviewOf`/`reviewOfRefs` create writer→reviewer prerequisite edges owned by
  the reviewer: `reviewOfRefs` resolve to allocated IDs appended after explicit
  `reviewOf`, and the union of `blockedByRefs` + `reviewOfRefs` orders writers
  before their reviewers. Every new task starts with `attempt` 0 and `maxAttempts` from the
  configured `maxAttempts` (8 unless overridden, 0 for unlimited). The result is
  `{ created: [{ ref, id }, ...], tasks: [...] }`. Validation and persistence
  happen once for the proposed batch; any failure leaves tasks, `nextId`, and
  the file unchanged.
- `task_update { updates: [{ id, subject?, description?, status?, blockedBy?, reviewOf?, metadata?, appendLog? }, ...] }`
  patches one or more tasks atomically. `updates` must be non-empty and may
  contain each numeric ID only once. When `enableAssignment` is `true`, each
  patch additionally accepts `assignment?: Assignment|null`; omission preserves,
  an object replaces the whole value, and `null` removes it. It is a declarative patch set, not a
  command sequence: all patches are applied to a cloned proposed state, then
  lifecycle and dependency rules are evaluated from original state to the
  complete proposed final state. Thus a dependency may become `completed`
  while its dependent enters `in_progress` in the same request, regardless of
  array order. The result is `{ updated: [...] }` containing actual post-update
  tasks. Any invalid patch or persistence failure rolls back every field,
  attempt, timestamp, log entry, timer, and notification.
  `metadata` shallow-merges; `appendLog` adds `{ timestamp, message }` to the
  append-only `log`; and `blockedBy`/`reviewOf`
  each replace the whole list. Every successfully patched task refreshes
  `updatedAt` without changing `createdAt`. Entering `in_progress` from an
  original non-`in_progress` state increments `attempt`; remaining
  `in_progress` does not. Entry is refused at `maxAttempts`, except for
  unlimited tasks (`maxAttempts` 0). Attempt timing is derived from the same
  original → proposed transition. `attempt` and `maxAttempts` cannot be
  updated directly. Completed tasks reopen via `completed` → `in_progress`
  (rework), never back to `pending`.
- Lifecycle: allowed transitions are `pending` → `in_progress` | `deleted`,
  `in_progress` → `paused` | `completed`, `paused` → `in_progress` | `deleted`,
  `completed` → `in_progress`, and `deleted` → none. Same-status patches are
  allowed and need no log. Every real status transition requires a non-empty
  `appendLog` (start, pause, resume, completion, rework, deletion); the update
  is rejected atomically otherwise. Entering `in_progress` from any other
  state increments `attempt` and enforces completed dependencies and the
  attempt cap. `pending` is initial-only (legacy `pending` with `attempt` > 0
  loads as `paused`). `in_progress` → `paused` freezes the running attempt
  into `tookMs`, clears `startedAt`, and banks the global active slice exactly
  like a completion. `paused` → `in_progress` is a resume: it enforces
  completed dependencies and the attempt cap, increments `attempt`, clears
  `tookMs`, and starts a fresh timer. `completed` → `in_progress` is the
  rework route. Paused dependencies do not satisfy `blockedBy`. Paused tasks
  prevent terminal-cycle archival and survive `clearCompleted`. Legacy
  persisted `failed` loads as `paused`.
- Deleted status: `task_update` accepts terminal `status: "deleted"`. The task
  record and logs remain visible; transition back to another status is refused.
  Entering deleted is refused while any final-state non-deleted task references
  it via `blockedBy` or via `reviewOf` (a writer referenced by a non-deleted
  reviewer), but one atomic update may mark a dependent and its dependency deleted
  together. Deleted reviewers are inert: their own `reviewOf` neither gates
  transitions nor blocks writer deletion. Leaving `in_progress` for deleted freezes `tookMs` and updates union
  timing like other terminal transitions.
- Reviews: `reviewOf: number[]` (default `[]`) lives on the reviewer and lists
  reviewed writer IDs. Effective prerequisites are the de-duplicated
  order-preserving union of `blockedBy` then `reviewOf`; for `deleted` tasks
  `reviewOf` is inert. A reviewer may enter or remain `in_progress` only when
  every ID in its `blockedBy` ∪ `reviewOf` is `completed`; a writer is gated only
  by its own `blockedBy` and never by reviewer state. One non-deleted reviewer
  may cover many writers, but a writer may have only one non-deleted reviewer;
  deleted reviewers are ignored and a second covering reviewer is rejected
  atomically (`Task #<writer> is already reviewed by #<reviewer>.`). There are no
  automatic review resets and no multi-reviewer voting semantics.
- `task_get { id }` and `task_list { status? }` return deleted tombstones as well
  plus the persisted `reviewOf` field;
  `task_list { status: "deleted" }` filters them explicitly. There is no
  `task_delete` tool.

Dependency invariants everywhere: references must exist, no self-reference,
no cycles. Invalid and not-found operations return clear error tool results.

In the interactive terminal, all four tools use a count-free animated working
label and a compact themed summary that expands to task rows or core operational
details. The pending spinner frame uses theme `accent` and the pending label
uses theme `toolTitle`; plain/no-theme/theme-throw fallbacks keep the exact
unstyled pending string and animation. In the interactive host, the spinner starts during pre-execution
argument streaming when a stable tool-call ID is available (with a static safe
fallback otherwise), then continues through execution. Replay and HTML export,
whose first call render is already execution-started, do not create a spinner or
loading row. On settlement the zero-height call component leaves only the result
visible. Settled success, failure, empty-state, and detail text use the host theme. Update rows report actual changed fields (including `reviews` diffs) with review-aware glyphs, get shows only
recent operational context plus a `Review of` row on reviewers, and list rows use review-aware glyphs resolved against the full task set (so a `status` filter does not change `○`/`●`); static tool output uses the first `in_progress` frame. Expected errors are sanitized while unexpected
details are masked. This presentation does not change tool schemas or the
JSON/error text returned to the model.

Bulk `clearCompleted`/`clearAll` commit in a single temp-file+rename write
(never repeated deletes): `clearCompleted` preserves completed writers referenced
by surviving review chains via fixed point — starting from non-completed tasks,
any completed writer reachable directly or transitively through `reviewOf` edges
of surviving non-deleted review tasks is retained — and strips only removable IDs
from remaining tasks' `blockedBy`/`reviewOf` lists, never leaving a dangling
`reviewOf`; `clearAll` resets active timing
while preserving `nextId` and any previously archived history. Manual clears
still delete the selected active-task records rather than archiving them. Either
is a no-op without writing when there is nothing to remove, and persistence
failure leaves in-memory state unchanged.

## Command

`/tasks` loads the current session store and shows an inline `Tasks` selector
with live counts:

- `View all tasks (N)` — centered overlay with the task list on the left and
  full details for the selected task on the right (status, id/attempts,
  description, blockedBy, Review of (reviewers only), timestamps/timing, metadata, log). When
  `enableAssignment` is `true`, details also show the assignment row. The
  attempt counter is omitted in rows and details for unlimited tasks
  (`maxAttempts` 0); row glyphs use the fixed review-aware glyphs. The
  outer border renders in the theme's `border` color (plain when theming is
  unavailable). Keys: the configured `tui.editor.cursorUp` /
  `tui.editor.cursorDown` bindings change selection, PageUp/PageDown scrolls
  details, Escape or Ctrl+C closes. Terminal-only: other modes get a
  notification instead.
- `Clear completed (M)` — confirms, then atomically removes all completed
  tasks (see above).
- `Clear all (N)` — confirms, then atomically removes all tasks (see above).

Zero-count clears notify and do nothing; declining a confirmation cancels
cleanly. Successful clears refresh (or remove, when empty) the persistent
widget immediately and notify; failures preserve state and report an error.
There is no Create-task command: tasks are created via `task_create` only.

## Widget

A persistent `tasks` widget renders numeric ID, the remaining-attempts indicator
`↻N` (`max(0, maxAttempts - attempt)`, so `attempt` 0 shows `maxAttempts`,
`attempt` 1 shows `maxAttempts - 1`, and an exhausted task shows `↻0`; omitted
for unlimited tasks with `maxAttempts` 0), subject, and per-attempt timing
with the fixed status glyph for pending,
in-progress, paused, completed, and deleted tasks. When `enableAssignment` is
`true`, each line additionally shows `@self` for direct assignment or the
optional `@<owner>` for delegated assignment between the
remaining-attempts indicator and the subject. Fixed glyphs: fresh pending
(`attempt` 0) `◌`, retried pending (`attempt` > 0) `■`, paused `⏸`, deleted `⌫`,
completed awaiting its active reviewer `○`, other completed `●`, and `in_progress`
frames `["◌", "○", "⨀", "◉", "●", "◉", "⨀", "○", "◌"]`. A completed writer shows `○` while an
active (non-deleted, non-completed) reviewer covers it and `●` when it has no
reviewer or its reviewer is completed; a completed reviewer marks its directly
reviewed writer accepted `●` even while that reviewer itself awaits another
review (presentation only, never transition gating). Shorter `#<id>`
labels are right-padded to the widest ID in the rendered set so the `↻N`
column starts at a consistent position. Shorter `↻N` labels are right-padded
to the widest finite-task remaining-attempts label in the set (e.g. `↻8 ` against `↻10`)
so the assignment column starts consistently; unlimited tasks show no `↻N` but
reserve that width as spaces when at least one finite task is present. Assignment
labels are left-aligned and padded to the widest visible label so subjects align;
tasks without an assignment reserve that width only in mixed sets.
When every task is unlimited, no remaining-attempts column is added. When `enableAssignment`
is `false`, or when no displayed task
has an assignment, no assignment column is added. The `/tasks`
list/detail views and JSON payloads keep the numeric `(<attempt>/<maxAttempts>)`
counter. Glyph colors are
fixed and derived from status: fresh pending tasks (`attempt` 0) render dim/gray,
retried pending tasks (`attempt` > 0) render yellow/warning so retries stay visible
across reloads, `in_progress` and `completed` render green/success, `paused`
renders yellow/warning, and `deleted` renders dim/gray. Subjects render in
the default text color (white) while pending, default text color and bold while in progress,
dim gray without strikethrough when completed or paused, and dim gray with
strikethrough when deleted. The optional
assignment label, including its right-padding, uses the same color, bold weight, and decoration
as the subject. There is no per-task or configured glyph or color: tool calls that
supply `color` are rejected, and persisted legacy `color` fields are ignored on load
and omitted on write.
`in_progress` lines append the running attempt duration from `startedAt` to now
(`0s` at zero); `completed`, `paused`, and `deleted` lines append only the frozen
`<duration>` (`0s` when zero); `pending` lines show no duration. Pending and paused rows with
prerequisites append ` → (ids)`: reviewers show their effective prerequisites
(`blockedBy` ∪ `reviewOf`), writers show `blockedBy`. Plain deleted
rows append `[deleted]`, and `/tasks` rows do the same.
The header shows `❯ Tasks · N total · M done` (including `0 done`), plus ` · P paused`
and ` · D deleted` when those counts are nonzero. After any task has entered `in_progress`, it
also shows the global accumulated active (wall-clock union) time (`0s` when the
measured total is still below one second); before then, the total is omitted.
The total runs while at least one task is `in_progress`, excludes idle gaps
without double-counting concurrency, and resumes across restarts and rework.
Themed header renders the `❯ Tasks` title in accent (only `Tasks` bold) with the full stats tail dim/gray, and elapsed/completed duration text renders dim/gray, and the plain fallback
includes the same text without styling.
Pure rendering accepts an explicit current time (plus optional union timing)
for deterministic output. The
in-progress glyph animates through the fixed frames every 250 ms, alternating
frames with a same-width blank blink-off frame; the blink timer runs only while an
in-progress task is shown. Static surfaces (plain lines, viewer rows, tool rendering)
use the first frame. A separate 1 s timer requests redraws only while
an in-progress task is shown so elapsed text stays current. All timers stop when the widget is replaced or removed.
Rendering
is presentational only (`src/widget.ts` never touches store state).

## Subagents

The tools register in the host/main Pi extension context only. There is no
shared or subagent store; subagents must not use these tools.

## Checks

- `npm test` — Vitest suite (store, lifecycle, widget, tools).
- `npm run typecheck` — `tsc --noEmit`.
