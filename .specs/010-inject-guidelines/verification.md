# Verification — 010 Inject Guidelines

## Supersession note

010 supersedes 009 A2: the `before_agent_start` handler is registered when
`injectGuidelines` is `true` (the default), so the 009 no-handler requirement
no longer holds. Summary-only tool descriptions remain: all four descriptions
stay short `Use this tool to` summaries with no ownership/assignee guidance
in either mode.

## Checks

- `npm test -- test/config.test.ts test/tools.test.ts test/assignee-config.test.ts`
  (focused: config loader, tool registration/injection, assignee gating).
- `npm test` (full suite — guards widget/store/lifecycle regressions).
- `npm run typecheck` (`tsc --noEmit` — catches the new required
  `PiTasksConfig` field in literals such as `test/unlimited.test.ts`).
- `git diff --check` (no whitespace errors).
- `grep -rn "before_agent_start\|injectGuidelines" src/ test/ README.md .specs/010-inject-guidelines/`
  (handler registered once in `src/index.ts`, config threaded through
  `src/config.ts`, tests and docs reference it; no `promptGuidelines`,
  no `SYSTEM.md`).
- Self-inspect `git diff` for scope: only `src/config.ts`, `src/index.ts`,
  `test/config.test.ts`, `test/tools.test.ts`, `test/assignee-config.test.ts`,
  `test/unlimited.test.ts` (required-field literal), `README.md`, and new
  `.specs/010-inject-guidelines/` carry 010 changes — with pre-existing
  uncommitted spec-009 hunks preserved untouched, including the carried-through
  glyph hunks in `src/widget.ts`, `test/widget.test.ts`, `test/paused.test.ts`,
  and `test/timing.test.ts`.

## Content-source evidence

- `git show 69135c4:src/index.ts` block region
  (`const taskManagementPrompt` … `</task-management>\`;`) diffed against the
reintroduced block: identical (`BLOCK-IDENTICAL`).
- `TASK_MANAGEMENT_START` / `TASK_MANAGEMENT_ASSIGNMENT_SECTION` constants:
  identical (`CONST-IDENTICAL`).
- Handler body (`selectedTools` gating, duplicate guard, append shape):
  identical; only wrapped in `if (config.injectGuidelines)`.
