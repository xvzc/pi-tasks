# pi-tasks

Local Pi extension for per-main-session task tracking.

## Stores

One file per main session: `<cwd>/.pi/tasks/tasks-{sanitizedSessionId}.json`
with envelope `{ version: 1, nextId, tasks, totalActiveMs, activeSince? }`. Session IDs are encoded as a
filename-safe readable prefix plus a deterministic SHA-256 digest. IDs allocate monotonically from
`nextId` and deleted IDs are never reused. Writes are atomic (temp file +
rename).

Timing state persists in the same envelope so reloads neither reset running
timers nor count idle gaps: each task carries `startedAt?` (start of the
current `in_progress` attempt) and `tookMs?` (frozen duration of the last
completed attempt); the envelope carries `totalActiveMs` (finished
wall-clock union time while at least one task was `in_progress`) and
`activeSince?` (start of the running period, if any). Reloading preserves
running values; legacy files without timing start counting from load time
(a legacy `in_progress` task without `startedAt` starts its attempt at the
load timestamp, matching the global `activeSince` load-time behavior)
and legacy completed tasks fall back to frozen `createdAt`→`updatedAt` spans.

Turn lifecycle (`turn_start`, initialized from `ctx.sessionManager.getSessionId()`
and the current cwd): never deletes anything, so an all-completed list stays
on disk and visible across turns. `TaskCreate` atomically resets first: if the
store holds ≥ 1 tasks that are all completed, the new task is validated
against a fresh state and committed as task #1 in a single temp-file+rename
write that replaces the old envelope. Failed validation or persistence leaves
the old completed file untouched. A list with any pending/in-progress task is
kept and appended with the existing `nextId`.

Note: concurrent writers across processes rely on the atomic rename but take
no interprocess lock; overlapping writes may lose one update (last rename
wins). This is a pre-existing limitation.

## Tools

Exactly five tools; no convenience, dependency, or subagent tools:

- `TaskCreate { subject, description, assignee?, color?, blockedBy?, metadata?, maxAttempts? }`
  creates a `pending` task with `attempt` 0 and `maxAttempts` defaulting to 9.
  `blockedBy` entries must exist (`TaskUpdate` follows the same rule).
  `maxAttempts` is set once at creation and cannot be updated later.
- `TaskUpdate { id, subject?, description?, assignee?|null, color?|null, status?, blockedBy?, metadata?, appendLog? }`
  patches a task. `metadata` shallow-merges; `appendLog` accepts a string and
  adds `{ timestamp, message }` to the task's append-only `log`. It is intended for rework,
  validation, blocker, and handoff notes instead of rewriting `description`.
  `assignee: null` / `color: null` remove those fields; `blockedBy` replaces the whole list; every successful
  update refreshes `updatedAt` and never touches `createdAt`. Entering
  `in_progress` increments `attempt` and requires all dependencies completed;
  entry is refused once `attempt` reaches `maxAttempts`. The per-attempt timer
  (`startedAt`) starts at zero only on a real non-`in_progress` →
  `in_progress` transition and is preserved by `in_progress` → `in_progress`
  updates. Transitioning to `completed` freezes the attempt into `tookMs`;
  rework clears it so the new attempt starts at zero and the next completion
  overwrites it. `attempt` and
  `maxAttempts` cannot be updated directly. Completed tasks may
  return to `pending`.
- `TaskGet { id }` returns one task as JSON.
- `TaskList { status? }` returns tasks (optionally filtered) as JSON.
- `TaskDelete { id }` deletes a task; refused while other tasks depend on it.
  Deleting the final remaining task resets the global union timing to
  `totalActiveMs` 0 with no `activeSince` (IDs and `nextId` are preserved);
  deleting while tasks remain keeps the current union timing behavior.

Dependency invariants everywhere: references must exist, no self-reference,
no cycles. Invalid and not-found operations return clear error tool results.

Bulk `clearCompleted`/`clearAll` commit in a single temp-file+rename write
(never repeated deletes): `clearCompleted` also strips the removed completed
IDs from remaining tasks' `blockedBy` lists; `clearAll` resets active timing
while preserving `nextId`. Either is a no-op without writing when there is
nothing to remove, and persistence failure leaves in-memory state unchanged.

## Command

`/tasks` loads the current session store and shows an inline `Tasks` selector
with live counts:

- `View all tasks (N)` — centered overlay with the task list on the left and
  full details for the selected task on the right (status, id/attempts,
  assignee, description, blockedBy, timestamps/timing, metadata, log). The
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
There is no Create-task command: tasks are created via `TaskCreate` only.

## Widget

A persistent `tasks` widget renders numeric ID, the `(<attempt>/<maxAttempts>)`
counter, optional `[assignee]`,
subject, and per-attempt timing with distinct status glyphs
(`□` pending, `■` in progress, and `■` completed).
Pending glyphs always render gray, even when `color` is set; in-progress and
completed glyphs render green by default. Subjects render in the default text
color (white) while pending, green and bold while in progress, and gray with a
strikethrough when completed. The optional `[assignee]` always uses the same
color, bold weight, and strikethrough decoration as the subject. Optional task
`color` maps onto known theme accents for the in-progress and completed
status glyphs only. `in_progress` lines append the running attempt duration
from `startedAt` to now (`0s` at zero); `completed` lines append only the frozen
`<duration>` (`0s` when zero); `pending` lines show no duration.
The header shows the total count and only the done count (`● N task(s)
(M done)`, including `(0 done)`). After any task has entered `in_progress`, it
also shows the global accumulated active (wall-clock union) time (`0s` when the
measured total is still below one second); before then, the total is omitted.
The total runs while at least one task is `in_progress`, excludes idle gaps
without double-counting concurrency, and resumes across restarts and rework.
Themed total, elapsed, and completed duration text renders dim/gray, and the plain fallback
includes the same text without styling.
Pure rendering accepts an explicit current time (plus optional union timing)
for deterministic output. The
in-progress glyph blinks by alternating
with a same-width blank every 250 ms; the blink timer runs only while an
in-progress task is shown. A separate 1 s timer requests redraws only while
an in-progress task is shown so elapsed text stays current. All timers stop when the widget is replaced or removed.
Rendering
is presentational only (`src/widget.ts` never touches store state).

## Subagents

The tools register in the host/main Pi extension context only. There is no
shared or subagent store; subagents must not use these tools.

## Checks

- `npm test` — Vitest suite (store, lifecycle, widget, tools).
- `npm run typecheck` — `tsc --noEmit`.
