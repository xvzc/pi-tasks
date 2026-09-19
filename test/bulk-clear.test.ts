import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/store.js";
import type { StoreData } from "../src/types.js";

const dirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-bulk-"));
  dirs.push(dir);
  return new TaskStore(join(dir, "tasks.json"));
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

describe("clearCompleted", () => {
  it("removes completed tasks in one write and strips their IDs from blockedBy", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const dep = await store.create({ subject: "dep", description: "" });
    const main = await store.create({ subject: "main", description: "", blockedBy: [dep.id] });
    const solo = await store.create({ subject: "solo", description: "" });
    await store.update(dep.id, { status: "completed" });
    await store.update(solo.id, { status: "completed" });

    let writes = 0;
    const counting = await TaskStore.load(store.filePath, async (path, data: StoreData) => {
      writes += 1;
      const { mkdir, rename, writeFile, unlink } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const { randomUUID } = await import("node:crypto");
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.counting.tmp`;
      void randomUUID;
      await writeFile(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, path);
      await unlink(tmp).catch(() => {});
    });
    expect(counting.list()).toHaveLength(3);

    const removed = await counting.clearCompleted();
    expect(removed).toEqual([dep.id, solo.id]);
    expect(writes).toBe(1);
    expect(counting.list().map((task) => task.id)).toEqual([main.id]);
    // Dependency on the removed completed task is stripped so invariants hold.
    expect(counting.get(main.id)?.blockedBy).toEqual([]);
    // IDs are never reused.
    const next = await counting.create({ subject: "next", description: "" });
    expect(next.id).toBe(4);
  });

  it("is a no-op without writing when nothing is completed", async () => {
    const store = await freshStore();
    await store.create({ subject: "a", description: "" });
    let writes = 0;
    const counting = await TaskStore.load(store.filePath, async () => {
      writes += 1;
    });
    expect(await counting.clearCompleted()).toEqual([]);
    expect(writes).toBe(0);
    expect(counting.list()).toHaveLength(1);
  });

  it("keeps union timing when tasks remain and resets it when emptied", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "" });
    const keep = await store.create({ subject: "keep", description: "" });
    await store.update(a.id, { status: "in_progress" });
    vi.setSystemTime(T0 + 20_000);
    await store.update(a.id, { status: "completed" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 20_000 });

    await store.clearCompleted();
    expect(store.list().map((task) => task.id)).toEqual([keep.id]);
    expect(store.activeTiming()).toEqual({ totalActiveMs: 20_000 });

    // Emptying an all-completed list resets like the delete-final-task rule.
    await store.update(keep.id, { status: "completed" });
    vi.setSystemTime(T0 + 40_000);
    await store.clearCompleted();
    expect(store.list()).toEqual([]);
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0 });
    const data = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(data.totalActiveMs).toBe(0);
    expect(data.activeSince).toBeUndefined();
    expect(data.nextId).toBe(3);
  });

  it("leaves memory and disk unchanged when persistence fails", async () => {
    const setup = await freshStore();
    const dep = await setup.create({ subject: "dep", description: "" });
    await setup.create({ subject: "main", description: "", blockedBy: [dep.id] });
    await setup.update(dep.id, { status: "completed" });
    const beforeDisk = await readFile(setup.filePath, "utf8");

    const store = await TaskStore.load(setup.filePath, async () => {
      throw new Error("simulated write failure");
    });
    const before = store.list();
    await expect(store.clearCompleted()).rejects.toThrow(/simulated write failure/);
    expect(store.list()).toEqual(before);
    expect(store.get(2)?.blockedBy).toEqual([1]);
    expect(await readFile(setup.filePath, "utf8")).toBe(beforeDisk);
  });
});

describe("clearAll", () => {
  it("removes everything in one write, resets timing, and preserves nextId", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "" });
    await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress" });
    vi.setSystemTime(T0 + 15_000);
    await store.update(a.id, { status: "completed" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 15_000 });

    let writes = 0;
    const { mkdir, rename, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const counting = await TaskStore.load(store.filePath, async (path, data: StoreData) => {
      writes += 1;
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.clearall.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, path);
    });
    const removed = await counting.clearAll();
    expect(removed).toBe(2);
    expect(writes).toBe(1);
    expect(counting.list()).toEqual([]);
    expect(counting.activeTiming()).toEqual({ totalActiveMs: 0 });
    const data = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(data).toMatchObject({ version: 1, nextId: 3, tasks: [], totalActiveMs: 0 });
    const next = await counting.create({ subject: "fresh", description: "" });
    expect(next.id).toBe(3);
  });

  it("is a no-op without writing when already empty", async () => {
    const store = await freshStore();
    let writes = 0;
    const counting = await TaskStore.load(store.filePath, async () => {
      writes += 1;
    });
    expect(await counting.clearAll()).toBe(0);
    expect(writes).toBe(0);
  });

  it("leaves memory and disk unchanged when persistence fails", async () => {
    const setup = await freshStore();
    await setup.create({ subject: "a", description: "" });
    const beforeDisk = await readFile(setup.filePath, "utf8");
    const store = await TaskStore.load(setup.filePath, async () => {
      throw new Error("simulated write failure");
    });
    const before = store.list();
    await expect(store.clearAll()).rejects.toThrow(/simulated write failure/);
    expect(store.list()).toEqual(before);
    expect(await readFile(setup.filePath, "utf8")).toBe(beforeDisk);
  });
});
