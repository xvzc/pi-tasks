import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectivePrereqs,
  TaskStore,
  transitionEligibility } from "../src/store.js";
import type { Task } from "../src/types.js";
import { buildTaskDetailLines, taskRowLabel } from "../src/tasks-ui.js";
import { buildWidgetLines, statusGlyphFor } from "../src/widget.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-reviews-"));
  dirs.push(dir);
  return join(dir, "tasks.json");
}

async function freshStore(): Promise<TaskStore> {
  return new TaskStore(await freshPath());
}

function task(overrides: Partial<Task> & { id: number }): Task {
  const { id, ...rest } = overrides;
  return {
    id,
    subject: `Task ${id}`,
    description: "",
    status: "pending",
    attempt: 0,
    maxAttempts: 8,
    blockedBy: [],
    reviewOf: [],
    metadata: {},
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...rest };
}

describe("review graph semantics", () => {
  it("creates reviewOfRefs in writer-before-reviewer order and gates only the reviewer", async () => {
    const store = await freshStore();
    const result = await store.createMany([
      { ref: "review", subject: "Review", description: "", reviewOfRefs: ["writer"] },
      { ref: "writer", subject: "Write", description: "" },
    ]);
    const [writer, reviewer] = result.tasks;

    expect(result.created).toEqual([{ ref: "writer", id: 1 }, { ref: "review", id: 2 }]);
    expect(writer.reviewOf).toEqual([]);
    expect(reviewer.reviewOf).toEqual([writer.id]);
    expect(effectivePrereqs(reviewer)).toEqual([writer.id]);

    await expect(store.update(reviewer.id, { status: "in_progress", appendLog: "note" })).rejects.toThrow(
      "Task #2 cannot remain in_progress: dependencies not completed: #1.",
    );
    await expect(store.update(writer.id, { status: "in_progress", appendLog: "note" })).resolves.toMatchObject({ status: "in_progress" });
    await store.update(writer.id, { status: "completed", appendLog: "note" });
    await expect(store.update(reviewer.id, { status: "in_progress", appendLog: "note" })).resolves.toMatchObject({ status: "in_progress" });
  });

  it("rejects numeric self-review with the dependency self-reference error", async () => {
    const store = await freshStore();
    await expect(store.create({ subject: "Self review", description: "", reviewOf: [1] })).rejects.toThrow(
      "Task #1 cannot depend on itself.",
    );
  });

  it("reports combined in-progress reviewOf structure errors before eligibility errors", async () => {
    const store = await freshStore();
    const reviewer = await store.create({ subject: "Reviewer", description: "" });
    const before = store.get(reviewer.id);

    await expect(store.update(reviewer.id, { status: "in_progress", reviewOf: [999], appendLog: "note" })).rejects.toThrow(
      "Task #999 does not exist.",
    );
    await expect(store.update(reviewer.id, { status: "in_progress", reviewOf: [reviewer.id], appendLog: "note" })).rejects.toThrow(
      "Task #1 cannot depend on itself.",
    );
    expect(store.get(reviewer.id)).toEqual(before);
  });

  it("enforces one active reviewer and makes a deleted reviewer inert", async () => {
    const store = await freshStore();
    const writer = await store.create({ subject: "Write", description: "" });
    const first = await store.create({ subject: "Review 1", description: "", reviewOf: [writer.id] });

    await expect(store.create({ subject: "Review 2", description: "", reviewOf: [writer.id] })).rejects.toThrow(
      "Task #1 is already reviewed by #2.",
    );
    await expect(store.update(writer.id, { status: "deleted", appendLog: "note" })).rejects.toThrow(
      "Task #1 cannot be deleted: referenced by #2.",
    );
    await store.update(first.id, { status: "deleted", appendLog: "note" });
    const second = await store.create({ subject: "Review 2", description: "", reviewOf: [writer.id] });
    expect(second.reviewOf).toEqual([writer.id]);
    expect((await store.update(second.id, { reviewOf: [] })).reviewOf).toEqual([]);
    await expect(store.update(writer.id, { status: "deleted", appendLog: "note" })).resolves.toMatchObject({ status: "deleted" });
  });

  it("uses direct review completion for acceptance even when the reviewer awaits another review", () => {
    const writer = task({ id: 1, status: "completed" });
    const reviewer = task({ id: 2, status: "completed", reviewOf: [1] });
    const upperReviewer = task({ id: 3, reviewOf: [2] });
    const tasks = [writer, reviewer, upperReviewer];

    expect(statusGlyphFor(writer, tasks)).toBe("●");
    expect(statusGlyphFor(reviewer, tasks)).toBe("○");
    expect(buildWidgetLines(tasks)[1]).toContain("● #1");
    expect(taskRowLabel(reviewer, undefined, tasks)).toContain("○ #2");
  });

  it("shows reviewer effective prerequisites and review detail", () => {
    const reviewer = task({ id: 3, blockedBy: [1], reviewOf: [2, 1] });
    expect(effectivePrereqs(reviewer)).toEqual([1, 2]);
    expect(taskRowLabel(reviewer)).toContain("→ (1, 2)");
    expect(buildTaskDetailLines(reviewer)).toContain("Review of: #2, #1");
  });
});

describe("review persistence and clearing", () => {
  it("loads legacy tasks with reviewOf [] and emits it on the next write", async () => {
    const path = await freshPath();
    const timestamp = "2026-01-01T00:00:00.000Z";
    await writeFile(path, JSON.stringify({
      version: 1,
      nextId: 2,
      tasks: [{
        id: 1,
        subject: "Legacy",
        description: "",
        status: "pending",
        attempt: 0,
        maxAttempts: 8,
        blockedBy: [],
        metadata: {},
        createdAt: timestamp,
        updatedAt: timestamp }] }));

    const store = await TaskStore.load(path);
    expect(store.get(1)?.reviewOf).toEqual([]);
    await store.save();
    expect(JSON.parse(await readFile(path, "utf8")).tasks[0].reviewOf).toEqual([]);
  });

  it("retains completed review chains by fixed point and removes them when no survivor pins them", async () => {
    const store = await freshStore();
    const writer = await store.create({ subject: "Write", description: "" });
    const reviewer = await store.create({ subject: "Review", description: "", reviewOf: [writer.id] });
    await store.create({ subject: "Upper review", description: "", reviewOf: [reviewer.id] });
    await store.update(writer.id, { status: "in_progress", appendLog: "note" });
    await store.update(writer.id, { status: "completed", appendLog: "note" });
    await store.update(reviewer.id, { status: "in_progress", appendLog: "note" });
    await store.update(reviewer.id, { status: "completed", appendLog: "note" });

    expect(await store.clearCompleted()).toEqual([]);
    expect(store.list().map(({ id }) => id)).toEqual([1, 2, 3]);
    await store.update(3, { status: "deleted", appendLog: "note" });
    expect(await store.clearCompleted()).toEqual([1, 2]);
    expect(store.get(3)?.reviewOf).toEqual([]);
  });
});

describe("transitionEligibility", () => {
  it("is pure and preserves lifecycle error order", () => {
    const dependency = task({ id: 1 });
    const current = task({ id: 2, status: "deleted", attempt: Number.MAX_SAFE_INTEGER, maxAttempts: 1 });
    const proposed = task({ ...current, status: "in_progress", reviewOf: [999] });
    const tasks = new Map([[dependency.id, dependency], [proposed.id, proposed]]);
    const before = structuredClone(proposed);

    expect(transitionEligibility(current, proposed, tasks)).toEqual({
      allowed: false,
      error: "Task #2 is deleted and cannot transition to another status." });
    expect(proposed).toEqual(before);

    const illegalPause = task({ id: 2, status: "paused", reviewOf: [2] });
    expect(transitionEligibility(task({ id: 2 }), illegalPause, new Map([[2, illegalPause]]))).toEqual({
      allowed: false,
      error: "Task #2 cannot transition from pending to paused." });

    const noLogCurrent = task({ id: 2 });
    const noLogProposed = task({ id: 2, status: "in_progress" });
    expect(transitionEligibility(noLogCurrent, noLogProposed, new Map([[2, noLogProposed]]))).toEqual({
      allowed: false,
      error: "Transition to in_progress requires a non-empty appendLog." });

    const exhaustedCurrent = task({ id: 2, attempt: 1, maxAttempts: 1 });
    const exhaustedProposed = task({ ...exhaustedCurrent, status: "in_progress", reviewOf: [999] });
    expect(transitionEligibility(exhaustedCurrent, exhaustedProposed, new Map([[2, exhaustedProposed]]), "note")).toEqual({
      allowed: false,
      error: "Task #2 has reached the maximum number of attempts (1)." });

    const overflowCurrent = task({ id: 2, attempt: Number.MAX_SAFE_INTEGER, maxAttempts: 0 });
    const overflowProposed = task({ ...overflowCurrent, status: "in_progress", reviewOf: [2] });
    expect(transitionEligibility(overflowCurrent, overflowProposed, new Map([[2, overflowProposed]]), "note")).toEqual({
      allowed: false,
      error: "Task #2 cannot enter in_progress: attempt counter has reached Number.MAX_SAFE_INTEGER." });

    const missing = task({ id: 2, reviewOf: [999] });
    expect(transitionEligibility(task({ id: 2 }), missing, new Map([[2, missing]]))).toEqual({
      allowed: false,
      error: "Task #999 does not exist." });
    const self = task({ id: 2, reviewOf: [2] });
    expect(transitionEligibility(task({ id: 2 }), self, new Map([[2, self]]))).toEqual({
      allowed: false,
      error: "Task #2 cannot depend on itself." });

    const blockedProposed = task({ id: 2, status: "in_progress", blockedBy: [1], reviewOf: [3, 1] });
    const other = task({ id: 3 });
    expect(transitionEligibility(task({ id: 2 }), blockedProposed, new Map([[1, dependency], [2, blockedProposed], [3, other]]), "note")).toEqual({
      allowed: false,
      error: "Task #2 cannot remain in_progress: dependencies not completed: #1, #3." });
  });
});
