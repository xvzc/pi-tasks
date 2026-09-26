import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  sanitizeSessionId,
  TaskStore,
  taskFilePath,
  turnStartStore,
} from "../src/store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
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
    expect(taskFilePath("/work", "a/b")).toContain(
      `/work/.pi/tasks/tasks-${sanitizeSessionId("a/b")}.json`,
    );
  });
});

describe("turn lifecycle", () => {
  it("keeps the file on the same turn the final task completes", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const store = await TaskStore.load(taskFilePath(cwd, sessionId));
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress", appendLog: "note" });
    await store.update(a.id, { status: "completed", appendLog: "note" });
    await store.update(b.id, { status: "in_progress", appendLog: "note" });
    await store.update(b.id, { status: "completed", appendLog: "note" });
    // Same-turn state: file still exists with both completed tasks.
    const path = taskFilePath(cwd, sessionId);
    expect(existsSync(path)).toBe(true);
    const reloaded = await TaskStore.load(path);
    expect(reloaded.list()).toHaveLength(2);
  });

  it("archives an all-completed list at the next turn start while preserving nextId", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const task = await store.create({ subject: "a", description: "" });
    await store.update(task.id, { status: "in_progress", appendLog: "start" });
    await store.update(task.id, { status: "completed", appendLog: "finished" });

    const result = await turnStartStore(cwd, sessionId);
    expect(result.cleaned).toBe(true);
    expect(result.store.list()).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      nextId: 2,
      tasks: [],
      history: [
        {
          tasks: [
            {
              id: 1,
              subject: "a",
              status: "completed",
              log: [{ message: "start" }, { message: "finished" }],
            },
          ],
        },
      ],
    });

    const recreated = await result.store.create({
      subject: "new",
      description: "",
    });
    expect(recreated.id).toBe(2);
  });

  it("archives a mixed completed/deleted terminal cycle", async () => {
    const cwd = await freshCwd();
    const sessionId = "mixed-terminal";
    const store = await TaskStore.load(taskFilePath(cwd, sessionId));
    const done = await store.create({ subject: "done", description: "" });
    const removed = await store.create({ subject: "removed", description: "" });
    await store.update(done.id, { status: "in_progress", appendLog: "note" });
    await store.update(done.id, { status: "completed", appendLog: "note" });
    await store.update(removed.id, {
      status: "deleted",
      appendLog: "out of scope",
    });

    const result = await turnStartStore(cwd, sessionId);
    expect(result.cleaned).toBe(true);
    expect(result.store.list()).toEqual([]);
    expect(result.store.listHistory()).toMatchObject([
      {
        tasks: [
          { id: done.id, status: "completed" },
          {
            id: removed.id,
            status: "deleted",
            log: [{ message: "out of scope" }],
          },
        ],
      },
    ]);
  });

  it("keeps create-time archival as a fallback for an all-completed store", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const first = await store.create({ subject: "old", description: "" });
    await store.update(first.id, { status: "in_progress", appendLog: "note" });
    await store.update(first.id, { status: "completed", appendLog: "note" });

    const task = await store.create({ subject: "new", description: "" });
    expect(task.id).toBe(2);
    expect(store.list().map((entry) => entry.subject)).toEqual(["new"]);
    expect(store.listHistory()).toMatchObject([
      { tasks: [{ id: 1, subject: "old" }] },
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      nextId: 3,
    });
    expect(
      (await TaskStore.load(path)).list().map((entry) => entry.subject),
    ).toEqual(["new"]);
  });

  it("preserves completed active tasks when archive-on-create validation fails (invalid subject)", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const task = await store.create({ subject: "old", description: "" });
    await store.update(task.id, { status: "in_progress", appendLog: "note" });
    await store.update(task.id, { status: "completed", appendLog: "note" });
    const beforeDisk = await readFile(path, "utf8");
    const before = store.list();

    await expect(
      store.create({ subject: "  ", description: "" }),
    ).rejects.toThrow(/subject/);
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
    expect((await TaskStore.load(path)).list()).toEqual(before);
  });

  it("preserves completed active tasks when archive-on-create references old tasks", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress", appendLog: "note" });
    await store.update(a.id, { status: "completed", appendLog: "note" });
    await store.update(b.id, { status: "in_progress", appendLog: "note" });
    await store.update(b.id, { status: "completed", appendLog: "note" });
    const beforeDisk = await readFile(path, "utf8");
    const before = store.list();

    // Old IDs do not exist in the fresh active state; archival must fail atomically.
    await expect(
      store.create({ subject: "new", description: "", blockedBy: [2] }),
    ).rejects.toThrow(/does not exist/);
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);

    await expect(
      store.create({ subject: "new", description: "", blockedBy: [1] }),
    ).rejects.toThrow(/itself|does not exist/);
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
  });

  it("preserves active completed tasks when archival persistence fails", async () => {
    const cwd = await freshCwd();
    const path = taskFilePath(cwd, "turn-reset-failure");
    const setup = await TaskStore.load(path);
    const task = await setup.create({ subject: "old", description: "" });
    await setup.update(task.id, { status: "in_progress", appendLog: "note" });
    await setup.update(task.id, { status: "completed", appendLog: "note" });
    const beforeDisk = await readFile(path, "utf8");

    const store = await TaskStore.load(path, async () => {
      throw new Error("simulated write failure");
    });
    const before = store.list();
    await expect(store.archiveTerminalCycle()).rejects.toThrow(
      /simulated write failure/,
    );
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
  });

  it("preserves completed active tasks when archive-on-create persistence fails", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const setup = await TaskStore.load(path);
    const task = await setup.create({ subject: "old", description: "" });
    await setup.update(task.id, { status: "in_progress", appendLog: "note" });
    await setup.update(task.id, { status: "completed", appendLog: "note" });
    const beforeDisk = await readFile(path, "utf8");

    let failWrites = true;
    const store = await TaskStore.load(path, async () => {
      if (failWrites) throw new Error("simulated write failure");
    });
    const before = store.list();
    await expect(
      store.create({ subject: "new", description: "" }),
    ).rejects.toThrow(/simulated write failure/);
    expect(store.list()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
    expect((await TaskStore.load(path)).list()).toEqual(before);

    failWrites = false;
    const created = await store.create({ subject: "new", description: "" });
    expect(created.id).toBe(2);
    expect(store.listHistory()).toMatchObject([
      { tasks: [{ id: 1, subject: "old" }] },
    ]);
  });

  it("appends with the existing nextId when any task is still active", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const a = await store.create({ subject: "a", description: "" });
    await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress", appendLog: "note" });
    await store.update(a.id, { status: "completed", appendLog: "note" });

    const task = await store.create({ subject: "c", description: "" });
    expect(task.id).toBe(3);
    expect((await TaskStore.load(path)).list()).toHaveLength(3);
    expect(existsSync(path)).toBe(true);
  });

  it("appends multiple completed cycles without overwriting prior history", async () => {
    const cwd = await freshCwd();
    const sessionId = "history-cycles";
    const path = taskFilePath(cwd, sessionId);
    const firstStore = await TaskStore.load(path);
    const first = await firstStore.create({
      subject: "first",
      description: "",
    });
    await firstStore.update(first.id, {
      status: "in_progress",
      appendLog: "note",
    });
    await firstStore.update(first.id, {
      status: "completed",
      appendLog: "note",
    });
    await turnStartStore(cwd, sessionId);

    const secondStore = await TaskStore.load(path);
    const second = await secondStore.create({
      subject: "second",
      description: "",
    });
    expect(second.id).toBe(2);
    await secondStore.update(second.id, {
      status: "in_progress",
      appendLog: "note",
    });
    await secondStore.update(second.id, {
      status: "completed",
      appendLog: "note",
    });
    const result = await turnStartStore(cwd, sessionId);

    expect(result.store.list()).toEqual([]);
    expect(
      result.store
        .listHistory()
        .map((cycle) => cycle.tasks.map((task) => task.subject)),
    ).toEqual([["first"], ["second"]]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      nextId: 3,
    });
  });

  it("keeps files with pending or mixed tasks at turn start", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const store = await TaskStore.load(taskFilePath(cwd, sessionId));
    const a = await store.create({ subject: "a", description: "" });
    await store.create({ subject: "b", description: "" });
    await store.update(a.id, { status: "in_progress", appendLog: "note" });
    await store.update(a.id, { status: "completed", appendLog: "note" });

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

  it("preserves monotonic IDs when archiving on create after reload", async () => {
    const cwd = await freshCwd();
    const sessionId = "session-1";
    const path = taskFilePath(cwd, sessionId);
    const store = await TaskStore.load(path);
    const first = await store.create({ subject: "old", description: "" });
    await store.update(first.id, { status: "in_progress", appendLog: "note" });
    await store.update(first.id, { status: "completed", appendLog: "note" });

    const next = await TaskStore.load(path);
    const task = await next.create({ subject: "new", description: "" });
    expect(task.id).toBe(2);
    expect(next.list().map((entry) => entry.subject)).toEqual(["new"]);
    expect(next.listHistory()).toMatchObject([
      { tasks: [{ id: 1, subject: "old" }] },
    ]);
  });
});

describe("attempt counters across turn lifecycle", () => {
  it("persists attempt counters when the file is kept at turn start", async () => {
    const cwd = await freshCwd();
    const sessionId = "attempt-session";
    const store = await TaskStore.load(taskFilePath(cwd, sessionId));
    const task = await store.create({
      subject: "a",
      description: "",
      maxAttempts: 3,
    });
    await store.update(task.id, { status: "in_progress", appendLog: "note" });
    const result = await turnStartStore(cwd, sessionId);
    expect(result.cleaned).toBe(false);
    expect(result.store.get(task.id)).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
    });
  });
});
