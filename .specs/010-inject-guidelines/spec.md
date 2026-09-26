# Specification — 010 Inject Guidelines

## Goal

Add boolean config `injectGuidelines` (default `true`) gating the
`<task-management>` system-prompt block, appended via `before_agent_start`
systemPrompt chaining only when enabled. Tool summary descriptions (009),
schemas, runtime, widget glyphs, and spec 009 are otherwise preserved; no
`promptGuidelines` is reintroduced and no `SYSTEM.md` is created.

## Supersession note

010 supersedes 009 A2: the `before_agent_start` handler IS registered when
`injectGuidelines` is `true` (the default), so the 009 no-handler requirement
no longer holds. The 009 summary-only tool descriptions remain in force —
all four descriptions stay short `Use this tool to` summaries with no
ownership/assignee guidance in either mode.

## Content source

- Block text recovered byte-identical from commit
  `69135c4` (`feat: expand task workflow and lifecycle`), file
  `src/index.ts`: `TASK_MANAGEMENT_START`, `TASK_MANAGEMENT_ASSIGNMENT_SECTION`,
  and the `taskManagementPrompt` template including its `enableAssignee`
  conditionals (`owners,` / `ownership,` / Assignment section).
- Prior handler behavior recovered from the same commit:
  `pi.on("before_agent_start", handler)` with
  `event { systemPrompt, systemPromptOptions }` returning `{ systemPrompt }`,
  injecting only when `selectedTools` includes `task_create`, with a
  duplicate-block guard. Both are kept unchanged.
- Only adjustment vs history: the whole registration is conditional on the
  new `injectGuidelines` flag (established 008 conditional owners/Assignment
  wording is preserved as-is; no new policy wording is invented).

## Behavior

- S1: `PiTasksConfig` gains `injectGuidelines: boolean`; `DEFAULT_CONFIG`
  sets it `true`; `ROOT_KEYS`, `cloneConfig`, and the loader follow the
  `enableAssignee` pattern (boolean guard, warn-and-fallback mentioning
  default `true`). Config file remains `pi-tasks.json`.
- S2: The static task-management block is built once at registration from
  the loaded config (so `enableAssignee` wording is fixed per registration).
- S3: Registration decision: the `before_agent_start` handler is registered
  only when `config.injectGuidelines` is `true` (conditional registration,
  not per-event early return — no handler overhead and no prompt mutation
  when disabled). When disabled, `promptSnippet` and all four summary
  descriptions are unchanged.
- S4: When enabled, the handler appends as
  `systemPrompt + "\n\n" + block`, skipping when `task_create` is not in
  `selectedTools` (absent/empty selection means no injection) and when the
  block marker is already present (chained-handler safe).

## Acceptance Criteria

- A1: `npm test`, `npm run typecheck`, and `git diff --check` pass.
- A2: `test/config.test.ts` covers default `true`, explicit `true`/`false`,
  and non-boolean warn-and-fallback to `true`.
- A3: `test/tools.test.ts` covers handler presence + append by default,
  duplicate protection, `selectedTools` gating, and handler absence with
  unchanged `promptSnippet`/descriptions when disabled.
- A4: `test/assignee-config.test.ts` covers handler presence by default in
  both assignee modes, absence when disabled, `promptGuidelines` still
  absent, and the owners/Assignment conditional wording structurally.
- A5: README Configuration example shows `injectGuidelines` with a bullet
  noting the interaction with summary descriptions.
