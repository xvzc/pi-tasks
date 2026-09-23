# Design — 006 Task Reviews

## Overview

Add reviewer-owned `reviewOf` as writer→reviewer prerequisite edges unified
behind preserved `effectivePrereqs` for reviewer execution and graph
validation, plus uniqueness, fixed-point clear, a general pure
`transitionEligibility` helper with frozen error order, and glyph extensions.
Smallest change satisfying spec.md while preserving store atomicity.

## Components

### Types (`src/types.ts`)

- Add `reviewOf: number[]` to `Task` with “IDs this review task reviews,
  default []” doc. No envelope change.

### Store (`src/store.ts`)

- `TASK_KEYS` gains `reviewOf`; `parseTask` defaults missing to `[]`,
  validates as ID list, clones on read/write (`cloneTask`, `cloneTasks`,
  `get`, `clearCompleted` survivor copy).
- `TaskCreateInput` / `TaskCreateBatchInput`: add `reviewOf?`,
  `reviewOfRefs?`; `TaskPatch`: add `reviewOf?` (replacement).
- `validateCreateBatchItem`: parse/validate both new fields like
  `blockedBy`/`blockedByRefs`.
- Batch `createMany`: build `refToIndex`, validate `reviewOfRefs`
  (unknown/self), extend `stableTopologicalOrder` to the union of both ref
  lists so writers allocate before their reviewers, resolve `reviewOfRefs`
  to IDs appended after explicit `reviewOf`.
- `updateMany` first pass: apply `reviewOf` replacement with `assertIdList`.
- New pure helpers:
  - `effectivePrereqs(task): number[]` — preserved; dedup union of
    `blockedBy` then `reviewOf`; deleted → `blockedBy` only. Writers
    normally yield `blockedBy`; reviewers yield writers plus `blockedBy`.
  - `checkReviewUniqueness(tasks): void` — at most one non-deleted cover per
    writer (E4).
  - `transitionEligibility(current, proposed, proposedTasks, appendLog?)` —
    general pure status-transition check returning
    `{ allowed: true } | { allowed: false, error: string }`, evaluated in
    existing error order: deleted-terminal → failed-appendLog →
    max-attempt cap → attempt overflow → effective-prerequisite completion
    (reviewer `eff`; writer `blockedBy`). No side effects; the store keeps
    attempt increment, `startedAt`/`tookMs`, `updatedAt`, and log append.
  - `reviewerFor(tasks, writerId): Task | undefined` — active covering
    reviewer for presentation and clear.
- `validateDependencies(tasks)`: existence/self/cycle over reviewer `eff`
  (writer `eff` = `blockedBy`); keep messages; `in_progress` rule delegates
  to `transitionEligibility` check (5).
- Deletion guard in `updateMany`: keep `blockedBy` incoming-edge scan and add
  the `reviewOf` incoming-edge arm (writer referenced by a non-deleted
  reviewer blocks deletion); this is not derived from the writer’s own `eff`.
- `clearCompleted`: compute removable set by fixed point — survivors are
  non-completed tasks plus completed reviewers that survive; retain any
  completed ID reachable via `reviewOf` from a surviving non-deleted task
  (iterate to closure); strip only removable IDs from both `blockedBy` and
  `reviewOf`; reuse existing timing/write path.

### Tools (`src/index.ts`)

- Extend `TaskCreateItem` schema with `reviewOf` / `reviewOfRefs` (TypeBox,
  same patterns/descriptions as blocked-by pair); extend `TaskUpdateItem`
  with `reviewOf`. Pass through to `store.createMany` / `updateMany`.
  No change to `maxAttempts` rejection or widget refresh.

### Config (`src/config.ts`)

- Extend normalized `PiTasksConfig` with `pending.retriedCharacter`,
  `completed.awaitingReviewCharacter`, `inProgress.frames`; keep
  `StatusGlyphConfig.character`. Normalized values remain ordinary enumerable,
  serializable fields. Character-only legacy input copies pending `character`
  to `retriedCharacter`, completed `character` to `awaitingReviewCharacter`,
  and in-progress `character` to `[character, same-width blank]`. Valid explicit
  `inProgress.frames` takes precedence over `character`; invalid explicit
  frames retain the default-frame fallback. Configured frames must share one
  visible width.

### Presentation (`src/widget.ts`, `src/tasks-ui.ts`, `src/tool-rendering.ts`)

- `statusGlyph`/`glyphThemeColor`: branch on fresh/retried pending, failed,
  deleted, completed-awaiting-reviewer (completed writer with active
  non-deleted, non-completed covering reviewer → `○`), other completed
  (`●`, including S8 accepted writers whose direct reviewer is completed
  even under an active upper reviewer — needs task-set context; add
  `statusGlyphFor(task, tasks?, config)` or pass reviewer set).
- `in_progress`: render only the normalized frame sequence at
  `BLINK_INTERVAL_MS` (250 ms). Character-only legacy input has already been
  normalized to character/blank frames, so spread and JSON round-trips retain
  behavior.
- Pending suffix shows own prerequisites (reviewer `eff`, writer
  `blockedBy`); viewer `taskRowLabel` / `buildTaskDetailLines` add reviewer
  `Review of` row; header builder unchanged (counts by `status`).

## Data Flow

```text
tool schema → validateCreateBatchItem → ref resolution → topological order (writers first)
  → allocate IDs → eff validation + uniqueness → atomic write
update patches → first pass (apply reviewOf) → transitionEligibility (pure, ordered:
  lifecycle → self/missing prerequisite structure → completion)
  → deletion guard (blockedBy + reviewOf incoming edges) → validateDependencies (cycle + eff)
  → store side effects → atomic write
clearCompleted → fixed-point retain set via reviewerFor → strip removable from both edges → atomic write
render → reviewer index (writer → active reviewer; S8 accepted) → glyph/frame selection
```

## Interfaces

- `effectivePrereqs(task: Task): number[]`
- `transitionEligibility(current: Task, proposed: Task, proposedTasks: Map<number, Task>, appendLog?: string): { allowed: true } | { allowed: false, error: string }`
- `checkReviewUniqueness(tasks: Map<number, Task>): void`
- `reviewerFor(tasks, writerId): Task | undefined` (presentation + clear).
- Config: `PiTasksConfig.glyphs.pending.retriedCharacter`,
  `glyphs.completed.awaitingReviewCharacter`, `glyphs.inProgress.frames`.

## Decisions

### D1. Reviewer-owned union edges

`reviewOf` lives on the reviewer and feeds preserved `effectivePrereqs` for
reviewer execution and graph validation; writers exclude reviewers from their
own `eff`. Satisfies S6–S8.

### D2. Deleted reviewers inert

Matches `deleted` tombstone treatment; keeps deletion and clear simple.
Satisfies S5, S6, S9.

### D3. Fixed-point (not one-hop) preservation in clearCompleted

Transitive review chains must not strand reviewers; iterate to closure.
Satisfies S9, A5.

### D4. General pure eligibility helper with frozen order

`transitionEligibility` covers deleted-terminal, failed-appendLog,
max-attempt, overflow, effective-prerequisite self/missing checks, and
prerequisite completion in that exact order. Cycle and review-uniqueness
validation remain later. The helper returns an allowed/denied discriminated
result; lifecycle side effects stay in the store and callers keep atomic
final-state validation. Satisfies N2, S14.

### D5. Serializable normalization with explicit-frames precedence

New keys default to R7. Character-only legacy input is expanded into the new
ordinary normalized fields, while valid explicit frames win whenever present.
No private provenance or value comparison is needed, and spread/JSON
round-trips preserve rendering behavior. Satisfies S12.

## Trade-offs

- S8 acceptance is presentation-only, so “review debt” chains remain
  executable; chosen to keep writer transitions unblocked per approved
  direction.
- Fixed-point clear may retain more completed tasks than a naive clear; this
  is intended to avoid dangling reviews.
- Presentation needs task-set context for awaiting/accepted glyphs; pure
  single-task `statusGlyph(task)` kept as fallback for static callers.
