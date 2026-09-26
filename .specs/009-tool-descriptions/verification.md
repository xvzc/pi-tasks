# Verification — 009 Tool Descriptions

## Commands

- Focused prompt/tool tests: `npx vitest run test/tools.test.ts test/assignee-config.test.ts`
- Full suite: `npm test`
- Types: `npm run typecheck`
- Whitespace: `git diff --check`
- Policy grep: `grep -rn "promptGuidelines\|taskCreateGuidelines" src/ test/ README.md .specs/009-tool-descriptions/`
  (expect matches only in negative test assertions and this spec's S7/A2 lines)
- Runtime/schema guard: `git diff --stat` shows no `src/store.ts`, schema,
  handler, widget-logic, or lifecycle changes; `git diff` on `README.md`
  shows exactly three hunk groups — the `enableAssignee` paragraph rewording,
  the Tools intro replacement, and the pre-existing `●` → `›` widget-title
  lines — while `src/widget.ts`, `test/widget.test.ts`, `test/paused.test.ts`,
  and `test/timing.test.ts` show only the pre-existing `●` → `›` hunks.

## Results (2026-09-23, current workspace)

- `npx vitest run test/tools.test.ts test/assignee-config.test.ts` → pass:
  `Test Files 2 passed (2)`, `Tests 43 passed (43)`.
- `npm test` → pass: `Test Files 18 passed (18)`, `Tests 364 passed (364)`.
- `npm run typecheck` → pass (`tsc --noEmit`, no output).
- `git diff --check` → clean (no output).
- Policy grep `grep -rn "promptGuidelines\|taskCreateGuidelines" src/ test/ README.md .specs/009-tool-descriptions/`
  → matches only in negative test assertions (`test/tools.test.ts`,
  `test/assignee-config.test.ts`) and the intentional removal notes in
  `.specs/009-tool-descriptions/spec.md`; `src/` and `README.md` are clean.
- `grep -rn "before_agent_start" src/` → no matches (only negative test
  assertions/capture scaffolding under `test/`).
- Scope: `git diff --stat` touches only `README.md`, `src/index.ts`,
  `test/tools.test.ts`, `test/assignee-config.test.ts` plus the pre-existing
  `●` → `›` hunks in `src/widget.ts`, `test/widget.test.ts`,
  `test/paused.test.ts`, `test/timing.test.ts`; the `README.md` diff holds
  exactly three hunk groups (the `enableAssignee` paragraph rewording, the
  Tools intro replacement, and the pre-existing `●` → `›` widget-title lines)
  and the latter four files contain only glyph changes (`test/widget.test.ts`
  has no non-glyph hunks).
  No store/schema/handler/widget-logic/lifecycle changes.

## Limitations

- Concurrent multi-process writers still last-rename-wins (pre-existing,
  unchanged).

## Addendum (2026-09-23, summary-only simplification)

- `src/index.ts`: all four tool descriptions are now summary-only direct
  template literals with no `## ` sections and no ownership guidance.
- `npx vitest run test/tools.test.ts test/assignee-config.test.ts` → pass
  (`Test Files 2 passed (2)`, `Tests 43 passed (43)`).
- `npm test` → pass (`Test Files 18 passed (18)`, `Tests 364 passed (364)`).
- `npm run typecheck` → pass; `git diff --check` → clean.
