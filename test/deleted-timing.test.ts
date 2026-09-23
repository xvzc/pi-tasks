import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/store.js";

const dirs: string[] = [];
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshStore(): Promise<TaskStore> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-deleted-timing-"));
  dirs.push(dir);
  return new TaskStore(join(dir, "tasks.json"));
}

describe("deleted transition timing", () => {
  it("keeps a completed task as a tombstone until terminal-cycle archival", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    await store.update(task.id, { status: "in_progress", appendLog: "note" });
    vi.setSystemTime(T0 + 20_000);
    await store.update(task.id, { status: "in_progress", appendLog: "note" });
    await store.update(task.id, { status: "completed", appendLog: "note" });
    // Deletion routes through pause: rework, pause, then delete at the same
    // timestamp so the frozen duration stays at the banked 20s total.
    await store.update(task.id, { status: "in_progress", appendLog: "rework" });
    await store.update(task.id, { status: "paused", appendLog: "pause" });
    await store.update(task.id, { status: "deleted", appendLog: "note" });

    expect(store.get(task.id)).toMatchObject({ status: "deleted" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 20_000 });
    expect(await store.archiveTerminalCycle()).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.listHistory()).toMatchObject([{ tasks: [{ id: task.id, status: "deleted" }] }]);
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0 });
  });

  it("freezes and banks elapsed time when deleting the sole in-progress task", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const running = await store.create({ subject: "running", description: "" });
    const pending = await store.create({ subject: "pending", description: "" });
    await store.update(running.id, { status: "in_progress", appendLog: "note" });

    vi.setSystemTime(T0 + 30_000);
    await store.update(running.id, { status: "paused", appendLog: "pausing" });
    const deleted = await store.update(running.id, { status: "deleted", appendLog: "note" });
    expect(deleted).toMatchObject({ status: "deleted", tookMs: 30_000 });
    expect(store.list().map((task) => [task.id, task.status])).toEqual([
      [running.id, "deleted"],
      [pending.id, "pending"],
    ]);
    expect(store.activeTiming()).toEqual({ totalActiveMs: 30_000 });
  });

  it("preserves activeSince when one of two in-progress tasks becomes deleted", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress", appendLog: "note" });
    await store.update(b.id, { status: "in_progress", appendLog: "note" });

    vi.setSystemTime(T0 + 20_000);
    await store.update(a.id, { status: "paused", appendLog: "pausing" });
    await store.update(a.id, { status: "deleted", appendLog: "note" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0, activeSince: new Date(T0).toISOString() });

    vi.setSystemTime(T0 + 70_000);
    await store.update(b.id, { status: "in_progress", appendLog: "note" });
    await store.update(b.id, { status: "completed", appendLog: "note" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 70_000 });
    const data = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(data.tasks).toMatchObject([{ id: a.id, status: "deleted" }, { id: b.id, status: "completed" }]);
  });

  it("does not disturb a running task when a pending peer becomes deleted", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const running = await store.create({ subject: "running", description: "" });
    const removed = await store.create({ subject: "removed", description: "" });
    await store.update(running.id, { status: "in_progress", appendLog: "note" });

    vi.setSystemTime(T0 + 10_000);
    await store.update(removed.id, { status: "deleted", appendLog: "note" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0, activeSince: new Date(T0).toISOString() });
  });
});
