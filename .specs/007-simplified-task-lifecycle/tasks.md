# Tasks — 007 Simplified Task Lifecycle

- [x] T1: Narrow `TaskStatus`, add `ALLOWED_TRANSITIONS` (`src/types.ts`).
- [x] T2: Universal adjacency + `appendLog` eligibility (`src/store.ts`).
- [x] T3: Legacy `failed`/`pending attempt>0` → `paused` on load (`src/store.ts`).
- [x] T4: Pause timing freeze/resume (`src/store.ts` `updateMany`).
- [x] T5: `paused` glyph config + legacy `failed` mapping (`src/config.ts`).
- [x] T6: Widget paused rendering/header/suffix (`src/widget.ts`).
- [x] T7: Tool schemas, descriptions, `<task-management>` prompt (`src/index.ts`).
- [x] T8: README lifecycle/widget/config docs.
- [x] T9: Rewrite `failed` suite as `paused`; update all affected suites
      (store, batch, lifecycle, reviews, timing, deleted-timing, tools,
      tasks-command, session-start, final-attempt, bulk-clear, unlimited,
      widget, tasks-ui, tool-rendering, config).
- [x] T10: Amend 006 spec (S15 note); leave 005 untouched (no changes needed).
- [x] T11: Full `npm test` + `npm run typecheck`; fix in-scope failures.
- [x] T12: Self-inspect diff for stale `failed`, missing `paused` support,
      direct `pending → completed` setups, and unrelated edits.
