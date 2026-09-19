import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/store.js";

const dirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshStore(): Promise<TaskStore> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-delete-timing-"));
  dirs.push(dir);
  return new TaskStore(join(dir, "tasks.json"));
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

describe("delete empty-list timing reset", () => {
  it("resets accumulated time when deleting the last completed task", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" });
    await store.update(created.id, { status: "in_progress" });
    vi.setSystemTime(T0 + 20_000);
    await store.update(created.id, { status: "completed" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 20_000 });

    vi.setSystemTime(T0 + 999_000);
    await store.delete(created.id);
    expect(store.list()).toEqual([]);
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0 });

    const data = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(data.totalActiveMs).toBe(0);
    expect(data.activeSince).toBeUndefined();
    expect(data.nextId).toBe(2);

    const reloaded = await TaskStore.load(store.filePath);
    expect(reloaded.activeTiming()).toEqual({ totalActiveMs: 0 });
    expect(reloaded.list()).toEqual([]);
  });

  it("discards the running slice when deleting the last in_progress task", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" });
    await store.update(created.id, { status: "in_progress" });

    vi.setSystemTime(T0 + 45_000);
    await store.delete(created.id);
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0 });

    const data = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(data.totalActiveMs).toBe(0);
    expect(data.activeSince).toBeUndefined();
  });

  it("preserves union timing when tasks remain after a deletion", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress" });

    vi.setSystemTime(T0 + 10_000);
    await store.delete(b.id);
    expect(store.list().map((task) => task.id)).toEqual([a.id]);
    expect(store.activeTiming().activeSince).toBe(new Date(T0).toISOString());

    vi.setSystemTime(T0 + 70_000);
    await store.update(a.id, { status: "completed" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 70_000 });
  });
});

describe("delete non-empty list timing", () => {
  it("banks elapsed union time when deleting the sole in_progress task", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0, activeSince: new Date(T0).toISOString() });

    vi.setSystemTime(T0 + 30_000);
    await store.delete(a.id);
    expect(store.list().map((task) => task.id)).toEqual([b.id]);
    expect(store.activeTiming()).toEqual({ totalActiveMs: 30_000 });

    const data = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(data.totalActiveMs).toBe(30_000);
    expect(data.activeSince).toBeUndefined();
  });

  it("preserves activeSince when deleting one of two in_progress tasks", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress" });
    await store.update(b.id, { status: "in_progress" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0, activeSince: new Date(T0).toISOString() });

    vi.setSystemTime(T0 + 20_000);
    await store.delete(a.id);
    expect(store.list().map((task) => task.id)).toEqual([b.id]);
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0, activeSince: new Date(T0).toISOString() });

    vi.setSystemTime(T0 + 70_000);
    await store.update(b.id, { status: "completed" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 70_000 });
  });
});
