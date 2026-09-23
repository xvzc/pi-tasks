import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskError, TaskStore, type TaskCreateBatchInput, type TaskStoreWriter } from "../src/store.js";
import type { StoreData } from "../src/types.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-batch-"));
  dirs.push(dir);
  return join(dir, "tasks.json");
}

async function freshStore(writer?: TaskStoreWriter): Promise<TaskStore> {
  return new TaskStore(await freshPath(), writer);
}

describe("atomic batch create", () => {
  it("creates multiple tasks in stable topological order regardless of input order", async () => {
    const store = await freshStore();
    const result = await store.createMany([
      { ref: "review", subject: "Review", description: "", blockedByRefs: ["implement"] },
      { ref: "implement", subject: "Implement", description: "", blockedByRefs: ["inspect"] },
      { ref: "inspect", subject: "Inspect", description: "" },
    ]);

    expect(result.created).toEqual([
      { ref: "inspect", id: 1 },
      { ref: "implement", id: 2 },
      { ref: "review", id: 3 },
    ]);
    expect(result.tasks.map((task) => [task.id, task.subject, task.blockedBy])).toEqual([
      [1, "Inspect", []],
      [2, "Implement", [1]],
      [3, "Review", [2]],
    ]);
    expect(store.list().map((task) => task.subject)).toEqual(["Inspect", "Implement", "Review"]);
    expect(JSON.stringify(store.list())).not.toContain('"ref"');
  });

  it("uses original input order as the tie-breaker for independent ready tasks", async () => {
    const store = await freshStore();
    const result = await store.createMany([
      { ref: "last", subject: "Last", description: "", blockedByRefs: ["first"] },
      { ref: "independent-a", subject: "Independent A", description: "" },
      { ref: "first", subject: "First", description: "" },
      { ref: "independent-b", subject: "Independent B", description: "" },
    ]);

    expect(result.tasks.map((task) => task.subject)).toEqual([
      "Independent A",
      "First",
      "Last",
      "Independent B",
    ]);
  });

  it("mixes existing numeric dependencies with batch-local refs", async () => {
    const store = await freshStore();
    const existing = await store.create({ subject: "Existing", description: "" });
    const result = await store.createMany([
      { ref: "local", subject: "Local", description: "" },
      {
        ref: "combined",
        subject: "Combined",
        description: "",
        blockedBy: [existing.id],
        blockedByRefs: ["local"] },
    ]);

    expect(result.tasks[1].blockedBy).toEqual([existing.id, result.tasks[0].id]);
  });

  it.each([
    [
      "duplicate refs",
      [
        { ref: "same", subject: "A", description: "" },
        { ref: "same", subject: "B", description: "" },
      ],
      /Duplicate task ref/,
    ],
    [
      "invalid ref slugs",
      [{ ref: "Invalid Ref", subject: "A", description: "" }],
      /must match/,
    ],
    [
      "unknown refs",
      [{ ref: "a", subject: "A", description: "", blockedByRefs: ["missing"] }],
      /Unknown blockedByRef/,
    ],
    [
      "self refs",
      [{ ref: "a", subject: "A", description: "", blockedByRefs: ["a"] }],
      /depend on itself/,
    ],
    [
      "cycles",
      [
        { ref: "a", subject: "A", description: "", blockedByRefs: ["b"] },
        { ref: "b", subject: "B", description: "", blockedByRefs: ["a"] },
      ],
      /dependency cycle/,
    ],
  ] as const)("rejects %s without changing memory, nextId, or disk", async (_name, items, message) => {
    const store = await freshStore();
    const existing = await store.create({ subject: "Existing", description: "" });
    const beforeDisk = await readFile(store.filePath, "utf8");

    const batch = items.map((item) => ({
      ...item,
      blockedByRefs: "blockedByRefs" in item ? [...item.blockedByRefs] : undefined })) as TaskCreateBatchInput[];
    await expect(store.createMany(batch)).rejects.toThrow(message);
    expect(store.list()).toEqual([existing]);
    expect(await readFile(store.filePath, "utf8")).toBe(beforeDisk);

    const next = await store.create({ subject: "Next", description: "" });
    expect(next.id).toBe(2);
  });

  it("rolls back the whole batch when one item is invalid and preserves per-task maxAttempts", async () => {
    const store = await freshStore();
    await expect(
      store.createMany([
        { subject: "Valid", description: "", maxAttempts: 2 },
        { subject: "  ", description: "" },
      ]),
    ).rejects.toThrow(/subject/);
    expect(store.list()).toEqual([]);
    expect(store.existsOnDisk()).toBe(false);

    const result = await store.createMany([
      { subject: "Default", description: "" },
      { subject: "Limited", description: "", maxAttempts: 2 },
    ], 7);
    expect(result.tasks.map((task) => task.maxAttempts)).toEqual([7, 2]);
  });

  it("archives an all-completed store and creates a topologically ordered batch atomically", async () => {
    const store = await freshStore();
    const original = await store.createMany([
      { subject: "Old A", description: "" },
      { subject: "Old B", description: "" },
    ]);
    for (const task of original.tasks) {
      await store.update(task.id, { status: "in_progress", appendLog: "note" });
    }
    await store.updateMany(original.tasks.map((task) => ({ id: task.id, status: "completed" as const, appendLog: "note" })));

    const result = await store.createMany([
      { ref: "review", subject: "Review", description: "", blockedByRefs: ["inspect"] },
      { ref: "inspect", subject: "Inspect", description: "" },
    ]);
    expect(result.tasks.map((task) => [task.id, task.subject, task.blockedBy])).toEqual([
      [3, "Inspect", []],
      [4, "Review", [3]],
    ]);
    expect(store.list().map((task) => task.subject)).toEqual(["Inspect", "Review"]);
    expect(store.listHistory()).toMatchObject([{ tasks: [{ id: 1, subject: "Old A" }, { id: 2, subject: "Old B" }] }]);
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0 });
  });

  it("handles multi-item ID exhaustion without partial allocation", async () => {
    const path = await freshPath();
    await writeFile(path, JSON.stringify({
      version: 1,
      nextId: Number.MAX_SAFE_INTEGER - 2,
      tasks: [],
      totalActiveMs: 0 }));
    const store = await TaskStore.load(path);
    const created = await store.createMany([
      { subject: "Penultimate A", description: "" },
      { subject: "Penultimate B", description: "" },
    ]);
    expect(created.tasks.map((task) => task.id)).toEqual([
      Number.MAX_SAFE_INTEGER - 2,
      Number.MAX_SAFE_INTEGER - 1,
    ]);
    const before = store.list();
    const beforeDisk = await readFile(path, "utf8");
    await expect(store.createMany([{ subject: "Exhausted", description: "" }])).rejects.toThrow(/exhausted/);
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
  });

  it("persists a successful batch exactly once and leaves state unchanged on write failure", async () => {
    const path = await freshPath();
    let writes = 0;
    const writer: TaskStoreWriter = async (filePath: string, data: StoreData) => {
      writes += 1;
      await writeFile(filePath, JSON.stringify(data, null, 2));
    };
    const store = new TaskStore(path, writer);
    await store.createMany([
      { ref: "a", subject: "A", description: "" },
      { ref: "b", subject: "B", description: "", blockedByRefs: ["a"] },
    ]);
    expect(writes).toBe(1);

    const before = store.list();
    const beforeDisk = await readFile(path, "utf8");
    const failing = await TaskStore.load(path, async () => {
      throw new Error("simulated batch write failure");
    });
    await expect(failing.createMany([{ subject: "C", description: "" }])).rejects.toThrow(/simulated batch write failure/);
    expect(failing.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
  });
});

describe("atomic declarative batch update", () => {
  it("applies multiple patches and validates dependencies against the complete proposed state", async () => {
    const store = await freshStore();
    const created = await store.createMany([
      { ref: "dependency", subject: "Dependency", description: "" },
      { ref: "dependent", subject: "Dependent", description: "", blockedByRefs: ["dependency"] },
    ]);
    const [dependency, dependent] = created.tasks;
    await store.update(dependency.id, { status: "in_progress", appendLog: "note" });

    const updated = await store.updateMany([
      { id: dependent.id, status: "in_progress", appendLog: "note", },
      { id: dependency.id, status: "completed", appendLog: "note", },
    ]);

    expect(updated.map((task) => [task.id, task.status, task.attempt])).toEqual([
      [dependency.id, "completed", 1],
      [dependent.id, "in_progress", 1],
    ]);
    expect(store.get(dependent.id)).toMatchObject({ status: "in_progress", attempt: 1 });
  });

  it("produces the same final state for either update-array ordering", async () => {
    const run = async (reverse: boolean) => {
      const store = await freshStore();
      const { tasks } = await store.createMany([
        { ref: "dependency", subject: "Dependency", description: "" },
        { ref: "dependent", subject: "Dependent", description: "", blockedByRefs: ["dependency"] },
      ]);
      await store.update(tasks[0].id, { status: "in_progress", appendLog: "note" });
      const updates = [
        { id: tasks[0].id, status: "completed" as const, appendLog: "note" },
        { id: tasks[1].id, status: "in_progress" as const, appendLog: "note" },
      ];
      const result = await store.updateMany(reverse ? [...updates].reverse() : updates);
      return result.map(({ id, status, attempt, blockedBy }) => ({ id, status, attempt, blockedBy }));
    };

    expect(await run(false)).toEqual(await run(true));
  });

  it("rejects duplicate IDs without changing state", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "A", description: "" });
    const before = store.get(task.id);
    const beforeDisk = await readFile(store.filePath, "utf8");
    await expect(
      store.updateMany([
        { id: task.id, status: "completed", appendLog: "note", },
        { id: task.id, appendLog: "duplicate" },
      ]),
    ).rejects.toThrow(/Duplicate task update id/);
    expect(store.get(task.id)).toEqual(before);
    expect(await readFile(store.filePath, "utf8")).toBe(beforeDisk);
  });

  it("rolls back every field, attempt, timestamp, log, timing, and disk when one patch is invalid", async () => {
    const store = await freshStore();
    const { tasks } = await store.createMany([
      { subject: "A", description: "" },
      { subject: "B", description: "" },
    ]);
    const before = store.list();
    const beforeTiming = store.activeTiming();
    const beforeDisk = await readFile(store.filePath, "utf8");

    await expect(
      store.updateMany([
        { id: tasks[0].id, status: "in_progress", appendLog: "would leak" },
        { id: tasks[1].id, subject: "   " },
      ]),
    ).rejects.toThrow(/subject/);

    expect(store.list()).toEqual(before);
    expect(store.activeTiming()).toEqual(beforeTiming);
    expect(await readFile(store.filePath, "utf8")).toBe(beforeDisk);
  });

  it("derives attempts only from original-to-proposed transitions", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "A", description: "" });
    expect((await store.updateMany([{ id: task.id, status: "in_progress", appendLog: "note", }]))[0].attempt).toBe(1);
    expect((await store.updateMany([{ id: task.id, status: "in_progress", appendLog: "note", subject: "Renamed" }]))[0].attempt).toBe(1);
    await store.updateMany([{ id: task.id, status: "paused", appendLog: "note", }]);
    expect((await store.updateMany([{ id: task.id, status: "in_progress", appendLog: "note", }]))[0].attempt).toBe(2);
  });

  it("derives task and global timing from the same final-state transition", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const store = await freshStore();
      const { tasks } = await store.createMany([
        { ref: "dependency", subject: "Dependency", description: "" },
        { ref: "dependent", subject: "Dependent", description: "", blockedByRefs: ["dependency"] },
      ]);
      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
      await store.update(tasks[0].id, { status: "in_progress", appendLog: "note" });
      const updated = await store.updateMany([
        { id: tasks[1].id, status: "in_progress", appendLog: "note", },
        { id: tasks[0].id, status: "completed", appendLog: "note", },
      ]);
      expect(updated[0]).toMatchObject({ status: "completed", tookMs: 0 });
      expect(updated[1]).toMatchObject({
        status: "in_progress",
        startedAt: "2026-01-01T00:00:05.000Z" });
      expect(updated[0].updatedAt).toBe(updated[1].updatedAt);
      expect(store.activeTiming()).toEqual({
        totalActiveMs: 0,
        activeSince: "2026-01-01T00:00:05.000Z" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires appendLog on transitions and rolls back the batch on attempt exhaustion", async () => {
    const store = await freshStore();
    const { tasks } = await store.createMany([
      { subject: "Limited", description: "", maxAttempts: 2 },
      { subject: "Other", description: "" },
    ]);
    await expect(store.updateMany([{ id: tasks[0].id, status: "in_progress" }])).rejects.toThrow(/appendLog/);
    await store.updateMany([{ id: tasks[0].id, status: "in_progress", appendLog: "starting" }]);
    await expect(store.updateMany([{ id: tasks[0].id, status: "paused" }])).rejects.toThrow(/appendLog/);
    const paused = await store.updateMany([{ id: tasks[0].id, status: "paused", appendLog: "paused once" }]);
    expect(paused[0]).toMatchObject({ status: "paused", attempt: 1 });
    expect(paused[0].log.at(-1)?.message).toBe("paused once");

    await store.updateMany([{ id: tasks[0].id, status: "in_progress", appendLog: "resume" }]);
    await store.update(tasks[0].id, { status: "in_progress", appendLog: "note" });
    await store.update(tasks[0].id, { status: "completed", appendLog: "note" });
    const before = store.list();
    const beforeDisk = await readFile(store.filePath, "utf8");
    await expect(
      store.updateMany([
        { id: tasks[0].id, status: "in_progress", appendLog: "note", },
        { id: tasks[1].id, subject: "Leaked" },
      ]),
    ).rejects.toThrow(/maximum number of attempts \(2\)/);
    expect(store.list()).toEqual(before);
    expect(await readFile(store.filePath, "utf8")).toBe(beforeDisk);
  });

  it("persists a successful update batch exactly once", async () => {
    const path = await freshPath();
    let writes = 0;
    const writer: TaskStoreWriter = async (filePath: string, data: StoreData) => {
      writes += 1;
      await writeFile(filePath, JSON.stringify(data, null, 2));
    };
    const store = new TaskStore(path, writer);
    const { tasks } = await store.createMany([
      { subject: "A", description: "" },
      { subject: "B", description: "" },
    ]);
    writes = 0;
    await store.updateMany([
      { id: tasks[0].id, status: "in_progress", appendLog: "note", },
      { id: tasks[1].id, subject: "Renamed" },
    ]);
    expect(writes).toBe(1);
  });

  it("keeps memory, timing, and disk unchanged when the single update write fails", async () => {
    const original = await freshStore();
    const { tasks } = await original.createMany([
      { subject: "A", description: "" },
      { subject: "B", description: "" },
    ]);
    const beforeDisk = await readFile(original.filePath, "utf8");
    const store = await TaskStore.load(original.filePath, async () => {
      throw new Error("simulated update write failure");
    });
    const before = store.list();
    const beforeTiming = store.activeTiming();

    await expect(
      store.updateMany([
        { id: tasks[0].id, status: "in_progress", appendLog: "would leak" },
        { id: tasks[1].id, subject: "Renamed" },
      ]),
    ).rejects.toThrow(/simulated update write failure/);
    expect(store.list()).toEqual(before);
    expect(store.activeTiming()).toEqual(beforeTiming);
    expect(await readFile(original.filePath, "utf8")).toBe(beforeDisk);
  });
});
