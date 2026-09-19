import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { sanitizeSessionId, TaskStore, taskFilePath, turnStartStore } from "../src/store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-lifecycle-"));
  dirs.push(dir);
  return dir;
}

describe("filename sanitization", () => {
  it("is deterministic, filename-safe, and collision-resistant", () => {
    const sanitized = sanitizeSessionId("a/b:c d");
    expect(sanitized).toBe(sanitizeSessionId("a/b:c d"));
    expect(sanitized).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sanitizeSessionId("a/b")).not.toBe(sanitizeSessionId("a:b"));
    expect(taskFilePath("/work", "a/b")).toContain(`/work/.pi/tasks/tasks-${sanitizeSessionId("a/b")}.json`);
  });
});

describe("turn lifecycle", () => {
  it("keeps the file on the same turn the final task completes", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const store = await TaskStore.load(taskFilePath(cwd, sessionId));
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "completed" });
    await store.update(b.id, { status: "completed" });
    // Same-turn state: file still exists with both completed tasks.
    const path = taskFilePath(cwd, sessionId);
    expect(existsSync(path)).toBe(true);
    const reloaded = await TaskStore.load(path);
    expect(reloaded.list()).toHaveLength(2);
  });

  it("preserves an all-completed file across turn starts", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const store = await TaskStore.load(taskFilePath(cwd, sessionId));
    const task = await store.create({ subject: "a", description: "" });
    await store.update(task.id, { status: "completed" });

    for (let turn = 0; turn < 2; turn++) {
      const result = await turnStartStore(cwd, sessionId);
      expect(result.cleaned).toBe(false);
      expect(result.store.list()).toHaveLength(1);
      expect(result.store.get(task.id)?.status).toBe("completed");
      expect(existsSync(taskFilePath(cwd, sessionId))).toBe(true);
    }
  });

  it("resets to ID 1 on create against an all-completed store", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const first = await store.create({ subject: "old", description: "" });
    await store.update(first.id, { status: "completed" });

    const task = await store.create({ subject: "new", description: "" });
    expect(task.id).toBe(1);
    expect(store.list().map((entry) => entry.subject)).toEqual(["new"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1, nextId: 2 });
    expect((await TaskStore.load(path)).list().map((entry) => entry.subject)).toEqual(["new"]);
  });

  it("preserves completed history when a reset create fails validation (invalid subject)", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const task = await store.create({ subject: "old", description: "" });
    await store.update(task.id, { status: "completed" });
    const beforeDisk = await readFile(path, "utf8");
    const before = store.list();

    await expect(store.create({ subject: "  ", description: "" })).rejects.toThrow(/subject/);
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
    expect((await TaskStore.load(path)).list()).toEqual(before);
  });

  it("preserves completed history when a reset create references old tasks", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "completed" });
    await store.update(b.id, { status: "completed" });
    const beforeDisk = await readFile(path, "utf8");
    const before = store.list();

    // Old IDs do not exist in the fresh state; the reset must fail atomically.
    await expect(store.create({ subject: "new", description: "", blockedBy: [2] })).rejects.toThrow(
      /does not exist/,
    );
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);

    await expect(store.create({ subject: "new", description: "", blockedBy: [1] })).rejects.toThrow(
      /itself|does not exist/,
    );
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
  });

  it("preserves completed history when a reset create fails persistence", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const setup = await TaskStore.load(path);
    const task = await setup.create({ subject: "old", description: "" });
    await setup.update(task.id, { status: "completed" });
    const beforeDisk = await readFile(path, "utf8");

    let failWrites = true;
    const store = await TaskStore.load(path, async () => {
      if (failWrites) throw new Error("simulated write failure");
    });
    const before = store.list();
    await expect(store.create({ subject: "new", description: "" })).rejects.toThrow(/simulated write failure/);
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
    expect((await TaskStore.load(path)).list()).toEqual(before);

    failWrites = false;
    const created = await store.create({ subject: "new", description: "" });
    expect(created.id).toBe(1);
  });

  it("appends with the existing nextId when any task is still active", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const a = await store.create({ subject: "a", description: "" });
    await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "completed" });

    const task = await store.create({ subject: "c", description: "" });
    expect(task.id).toBe(3);
    expect((await TaskStore.load(path)).list()).toHaveLength(3);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps files with pending or mixed tasks at turn start", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const store = await TaskStore.load(taskFilePath(cwd, sessionId));
    const a = await store.create({ subject: "a", description: "" });
    await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "completed" });

    const result = await turnStartStore(cwd, sessionId);
    expect(result.cleaned).toBe(false);
    expect(result.store.list()).toHaveLength(2);
    expect(existsSync(taskFilePath(cwd, sessionId))).toBe(true);
  });

  it("does nothing when no file exists at turn start", async () => {
    const cwd = await freshCwd();
    const result = await turnStartStore(cwd, "never-seen");
    expect(result.cleaned).toBe(false);
    expect(result.store.list()).toEqual([]);
  });

  it("starts at ID 1 for creates against an all-completed store, even across reloads", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const first = await store.create({ subject: "old", description: "" });
    await store.update(first.id, { status: "completed" });

    const next = await TaskStore.load(path);
    const task = await next.create({ subject: "new", description: "" });
    expect(task.id).toBe(1);
    expect(next.list().map((entry) => entry.subject)).toEqual(["new"]);
  });
});

describe("attempt counters across turn lifecycle", () => {
  it("persists attempt counters when the file is kept at turn start", async () => {
    const cwd = await freshCwd();
    const sessionId = "attempt-session";
    const store = await TaskStore.load(taskFilePath(cwd, sessionId));
    const task = await store.create({ subject: "a", description: "", maxAttempts: 3 });
    await store.update(task.id, { status: "in_progress" });
    const result = await turnStartStore(cwd, sessionId);
    expect(result.cleaned).toBe(false);
    expect(result.store.get(task.id)).toMatchObject({ attempt: 1, maxAttempts: 3 });
  });
});
