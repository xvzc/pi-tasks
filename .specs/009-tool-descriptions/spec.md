# Specification — 009 Tool Descriptions

## Goal

Replace the uncommitted `promptGuidelines` approach with summary-only
tool descriptions on the existing four tools. Each description is a short
unheaded summary starting with `Use this tool to`, with no Markdown
sections (`## When to Use`, `## Workflow`, `## Output`, `## Tips`, or
conditional `## Ownership`) and no assignee/owner/ownership guidance in
either mode. Schema gating for `enableAssignee` is unchanged.
Structure follows
tintinweb/pi-tasks only as a structural reference
(Purpose → When to Use → When NOT to Use when relevant →
Workflow/Output/Tips); all content matches this repository's actual
contracts. No semantics or wording is copied.

## Behavior

- S1: `task_create` description owns scope (when tracking is
  appropriate/inappropriate), initial materialization in one atomic batch,
  outcome-oriented tasks, active-plan fidelity, local refs vs numeric IDs,
  reviewOf prerequisite/no-duplication rules, and a pointer that rework
  belongs in `task_update`. It frames task creation as work-state tracking,
  preserves the no-dispatch fact, and keeps the unchanged `promptSnippet`.
- S2: `task_update` description owns lifecycle transitions, the appendLog
  rule, atomic jointly-known state changes, the execution-contract approval
  boundary, the rework sequence, safe blocking behavior, and
  deleted-only-for-intentional-scope-removal. It preserves the
  declarative/final-state validation facts.
- S3: `task_get` description owns full-detail retrieval and the freshness
  rule (reuse the latest successful response unless state is
  unknown/may have changed/full dependency-log detail is needed); it points
  to `task_list` for overview.
- S4: `task_list` description owns overview/status filtering and points to
  `task_get` for full detail; it avoids needless reads when the latest
  successful tool response is current.
- S5: Descriptions carry no assignee/owner/ownership wording in either mode.
  `enableAssignee` gates only the `assignee` schema fields. Schemas are unchanged.
- S6: Field-level regex/enums/merge details stay canonical in parameter
  descriptions and are not duplicated in tool descriptions.
- S7: Every `promptGuidelines` property and `taskCreateGuidelines` are
  removed. No `before_agent_start` prompt mutation is reintroduced.
- S8: README Tools intro describes detailed per-tool descriptions; all
  `promptGuidelines`/custom-SYSTEM limitation language is removed. The
  existing `› Tasks` hunks are preserved.

## Acceptance Criteria

- A1: `npm test`, `npm run typecheck`, and `git diff --check` pass.
- A2: All four tools expose no `promptGuidelines`; no `before_agent_start`
  handler is registered; `task_create.promptSnippet` is unchanged.
- A3: Disabled create/update/get/list descriptions contain no
  assignee/owner/ownership wording; enabled create/update add the ownership
  wording while get/list stay clean.
- A4: `git diff` on `README.md` shows exactly three hunk groups — the `enableAssignee` paragraph rewording, the Tools intro replacement, and the pre-existing `●` → `›` widget-title lines — while `src/widget.ts`, `test/widget.test.ts`, `test/paused.test.ts`, and `test/timing.test.ts` show only the pre-existing `●` → `›` widget-title changes.
