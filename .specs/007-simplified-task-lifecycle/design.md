# Design — 007 Simplified Task Lifecycle

## Approach

Prefer the smallest change that satisfies the contract: one immutable
adjacency map plus the existing eligibility helper, no guard/effect
framework, no new abstractions.

## Changes

- `src/types.ts`: narrow `TaskStatus` to R1; add exported
  `ALLOWED_TRANSITIONS` (S2). Update `attempt`/`tookMs` doc comments.
- `src/store.ts`:
  - File header rewritten for pause/rework semantics.
  - `parseTask`: normalize legacy `failed` → `paused`, then legacy
    retried-`pending` → `paused`, before `isTaskStatus` validation (S8).
  - `transitionEligibility`: adjacency check then universal `appendLog`
    check for `current.status !== proposed.status`; keep cap/overflow/
    prerequisite checks in their existing order (S3).
  - `updateMany` timing: freeze on `paused` exactly like the old `failed`
    branch; entry to `in_progress` unchanged (S4).
  - `clearCompleted` doc: `paused` survives (S5).
- `src/config.ts`: `glyphs.paused` (default `⏸`) replaces
  `glyphs.failed`; legacy `glyphs.failed` maps to `paused` with a warning
  (S8/C2).
- `src/widget.ts`: `paused` glyph, frozen-duration suffix, `· N paused`
  header segment, `warning` color, dim subject, pending+paused `→ (ids)`
  suffix (S6).
- `src/index.ts`: `paused` in the tool status union and descriptions;
  `<task-management>` Lifecycle/Rework/Pause sections rewritten (S7).
- `README.md`: config example, lifecycle, widget, and header docs (R9).
- `.specs/006-task-reviews/spec.md`: S15 amendment note only (history
  otherwise untouched).
- Tests: `test/failed.test.ts` → `test/paused.test.ts` rewritten for S3/E;
  all suites updated to legal transitions with per-transition logs;
  legacy-mapping, adjacency-rejection, and rework-batch coverage added.

## Alternatives Considered

- Keeping `failed` alongside `paused`: rejected — the contract removes it.
- Auto-pausing on dependency reopen: rejected — out of scope; rework stays
  explicit via the atomic batch.
- Separate pause/resume timestamps: rejected — reuse the existing
  `startedAt`/`tookMs` freeze/clear cycle; no new fields.

## Traceability

R1→S1/S7, R2→S2/S3/E2, R3→S3/S7/E3, R4→S3/S4, R5→S5, R6→S2/E2,
R7→S8/C1, R8→S4/S5, R9→S6/S7, R10→S8/C2.
