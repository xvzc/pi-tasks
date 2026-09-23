# Verification — 007 Simplified Task Lifecycle

## Commands (actual, current workspace)

- `npm run typecheck` → pass (`tsc --noEmit`, no output).
- `npm test` → pass: `Test Files 17 passed (17)`, `Tests 345 passed (345)`.
- Baseline before work (per assignment): 17 files / 343 tests passing and
  typecheck passing. Net test change: +2 (new adjacency-rejection and
  legacy-mapping cases in `test/paused.test.ts`).
- `grep -rn "failed" src/` → only legacy-load shims (`store.ts`
  `failed`→`paused` mapping comment/code, `config.ts` legacy glyph alias)
  and English prose (`Task viewer failed:`). No `failed` status, schema,
  default, or prompt path remains.
- `grep -rn '"failed"' test/ src/` → only `test/paused.test.ts:111`
  (legacy fixture asserting `failed` loads as `paused`) and the viewer
  prose above.

## Scope Checks

- Adjacency: illegal jumps (`pending → completed`, `completed → pending`,
  `in_progress → deleted`, `pending → paused`, `completed → deleted`)
  covered by rejection tests in `paused`/`store` suites.
- Universal log: log-less transitions rejected in `paused`/`batch` suites;
  same-status patches need no log (`paused → paused` case).
- Migration: `failed → paused`, retried-`pending → paused`, fresh-`pending`
  stays `pending` (dedicated test); v1 envelope without version bump.
- Rework: atomic reviewer-pause + writer-reopen batch covered in store
  semantics; reviewer resume requires writer `completed` (existing review
  gating, unchanged).
- 005 spec: untouched (no `failed` references; archiving rules unchanged).
  006 spec: S15 amendment note only.

## Limitations

- No orchestration task records created or updated (per output contract).
- Concurrent multi-process writers still last-rename-wins (pre-existing,
  unchanged).
