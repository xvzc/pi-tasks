import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskError, TaskStore } from "../src/store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshStore(): Promise<TaskStore> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-store-"));
  dirs.push(dir);
  return new TaskStore(join(dir, "tasks.json"));
}

async function persistedPath(data: unknown): Promise<string> {
  const store = await freshStore();
  await writeFile(store.filePath, JSON.stringify(data));
  return store.filePath;
}

const timestamp = "2025-01-02T03:04:05.000Z";

function persistedTask(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    subject: `task ${id}`,
    description: "",
    status: "pending",
    attempt: 0,
    maxAttempts: 9,
    blockedBy: [],
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("create/get/list/delete", () => {
  it("creates tasks with defaults and lists them by numeric id", async () => {
    const store = await freshStore();
    const a = await store.create({ subject: "First", description: "details" });
    const b = await store.create({ subject: "Second", description: "" });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.status).toBe("pending");
    expect(a.blockedBy).toEqual([]);
    expect(a.metadata).toEqual({});
    expect(store.list().map((task) => task.id)).toEqual([1, 2]);
    expect(store.get(1)?.subject).toBe("First");
    expect(store.get(999)).toBeUndefined();
  });

  it("allocates monotonically and never reuses deleted ids", async () => {
    const store = await freshStore();
    await store.create({ subject: "a", description: "" });
    await store.create({ subject: "b", description: "" });
    await store.delete(1);
    const c = await store.create({ subject: "c", description: "" });
    expect(c.id).toBe(3);
    expect(store.list().map((task) => task.id)).toEqual([2, 3]);
  });

  it("persists the versioned envelope and nextId across reloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-task-store-"));
    dirs.push(dir);
    const path = join(dir, "tasks.json");
    const first = await TaskStore.load(path);
    await first.create({ subject: "a", description: "" });
    await first.delete(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, nextId: 2, tasks: [], totalActiveMs: 0 });
    const second = await TaskStore.load(path);
    const task = await second.create({ subject: "b", description: "" });
    expect(task.id).toBe(2);
  });

  it("uses independent temporary files for concurrent saves and cleans them up", async () => {
    const store = await freshStore();
    await store.create({ subject: "a", description: "" });
    await Promise.all(Array.from({ length: 10 }, () => store.save()));
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toMatchObject({ version: 1, nextId: 2 });
    expect((await readdir(join(store.filePath, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects invalid create input", async () => {
    const store = await freshStore();
    await expect(store.create({ subject: "  ", description: "" })).rejects.toThrow(TaskError);
    await expect(store.create({ subject: "x", description: "", blockedBy: [42] })).rejects.toThrow(/does not exist/);
  });

  it("requires description on create", async () => {
    const store = await freshStore();
    await expect(store.create({ subject: "x" } as unknown as { subject: string; description: string })).rejects.toThrow(
      TaskError,
    );
  });

  it("rejects invalid ids", async () => {
    const store = await freshStore();
    await expect(store.update(0, { subject: "x" })).rejects.toThrow(/Invalid task id/);
    await expect(store.delete(-3)).rejects.toThrow(/Invalid task id/);
    expect(() => store.get(Number.MAX_SAFE_INTEGER + 1)).toThrow(/positive safe integer/);
    await expect(store.create({ subject: "x", description: "", blockedBy: [Number.MAX_SAFE_INTEGER + 1] })).rejects.toThrow(
      /positive safe integer/,
    );
    await expect(store.update(7, { subject: "x" })).rejects.toThrow(/does not exist/);
    await expect(store.delete(7)).rejects.toThrow(/does not exist/);
  });
});

describe("persisted store validation", () => {
  it("accepts a missing file but rejects missing and unsupported versions", async () => {
    const missing = await freshStore();
    await expect(TaskStore.load(missing.filePath)).resolves.toBeInstanceOf(TaskStore);
    await expect(TaskStore.load(await persistedPath({ nextId: 1, tasks: [] }))).rejects.toThrow(/version/);
    await expect(TaskStore.load(await persistedPath({ version: 2, nextId: 1, tasks: [] }))).rejects.toThrow(/version/);
  });

  it("rejects invalid or stale nextId values", async () => {
    await expect(TaskStore.load(await persistedPath({ version: 1, nextId: 0, tasks: [] }))).rejects.toThrow(/nextId/);
    await expect(
      TaskStore.load(await persistedPath({ version: 1, nextId: Number.MAX_SAFE_INTEGER + 1, tasks: [] })),
    ).rejects.toThrow(/nextId/);
    await expect(
      TaskStore.load(
        await persistedPath({
          version: 1,
          nextId: Number.MAX_SAFE_INTEGER,
          tasks: [persistedTask(Number.MAX_SAFE_INTEGER + 1)],
        }),
      ),
    ).rejects.toThrow(/positive safe integer/);
    await expect(
      TaskStore.load(await persistedPath({ version: 1, nextId: 1, tasks: [persistedTask(1)] })),
    ).rejects.toThrow(/nextId/);
  });

  it("rejects unknown version-1 envelope and task keys while allowing free-form metadata", async () => {
    await expect(
      TaskStore.load(await persistedPath({ version: 1, nextId: 1, tasks: [], extra: true })),
    ).rejects.toThrow(/unknown key: extra/);
    await expect(
      TaskStore.load(
        await persistedPath({ version: 1, nextId: 2, tasks: [persistedTask(1, { extra: true })] }),
      ),
    ).rejects.toThrow(/unknown key: extra/);
    await expect(
      TaskStore.load(
        await persistedPath({ version: 1, nextId: 2, tasks: [persistedTask(1, { metadata: { extra: true } })] }),
      ),
    ).resolves.toBeInstanceOf(TaskStore);
  });

  it("allocates the last ID with a representable counter, then rejects exhausted creation", async () => {
    const path = await persistedPath({ version: 1, nextId: Number.MAX_SAFE_INTEGER - 1, tasks: [] });
    const store = await TaskStore.load(path);
    const last = await store.create({ subject: "last", description: "" });
    expect(last.id).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(JSON.parse(await readFile(path, "utf8")).nextId).toBe(Number.MAX_SAFE_INTEGER);

    const before = await readFile(path, "utf8");
    await expect(store.create({ subject: "exhausted", description: "" })).rejects.toThrow(/exhausted/);
    expect(store.list()).toEqual([last]);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects malformed timestamps and duplicate ids", async () => {
    await expect(
      TaskStore.load(
        await persistedPath({ version: 1, nextId: 2, tasks: [persistedTask(1, { createdAt: "not-a-date" })] }),
      ),
    ).rejects.toThrow(/timestamp/);
    await expect(
      TaskStore.load(await persistedPath({ version: 1, nextId: 2, tasks: [persistedTask(1), persistedTask(1)] })),
    ).rejects.toThrow(/Duplicate/);
  });

  it.each([
    ["malformed blockedBy", [persistedTask(1, { blockedBy: ["bad"] })]],
    ["missing reference", [persistedTask(1, { blockedBy: [2] })]],
    ["self reference", [persistedTask(1, { blockedBy: [1] })]],
    ["cycle", [persistedTask(1, { blockedBy: [2] }), persistedTask(2, { blockedBy: [1] })]],
    [
      "incomplete dependency for in_progress",
      [persistedTask(1), persistedTask(2, { status: "in_progress", blockedBy: [1] })],
    ],
  ])("rejects an invalid dependency graph: %s", async (_name, tasks) => {
    await expect(TaskStore.load(await persistedPath({ version: 1, nextId: 3, tasks }))).rejects.toThrow(TaskError);
  });
});

describe("timestamps and patch semantics", () => {
  it("uses ISO 8601 UTC timestamps, refreshes updatedAt, never touches createdAt", async () => {
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" });
    expect(() => new Date(created.createdAt)).not.toThrow();
    expect(created.createdAt).toMatch(/Z$/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.update(created.id, { subject: "b" });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.createdAt).getTime());
  });

  it("shallow-merges metadata", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "", metadata: { keep: 1, over: "old" } });
    const updated = await store.update(task.id, { metadata: { over: "new", added: true } });
    expect(updated.metadata).toEqual({ keep: 1, over: "new", added: true });
  });

  it("appends timestamped log notes without changing the description", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "original" });
    expect(task.log).toEqual([]);

    const updated = await store.update(task.id, { appendLog: "  Rework after review  " });
    expect(updated.description).toBe("original");
    expect(updated.log).toHaveLength(1);
    expect(updated.log[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(updated.log[0].message).toBe("Rework after review");
    expect((await TaskStore.load(store.filePath)).get(task.id)?.log).toEqual(updated.log);
    await expect(store.update(task.id, { appendLog: "   " })).rejects.toThrow(/non-empty string/);
  });

  it("removes assignee/color on null", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "", assignee: "api", color: "red" });
    expect(task.assignee).toBe("api");
    const updated = await store.update(task.id, { assignee: null, color: null });
    expect("assignee" in updated).toBe(false);
    expect("color" in updated).toBe(false);
  });

  it("lets completed tasks return to pending", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    await store.update(task.id, { status: "completed" });
    const reopened = await store.update(task.id, { status: "pending" });
    expect(reopened.status).toBe("pending");
  });

  it("rolls back every field when a later part of an update fails", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "original", description: "before", metadata: { keep: true } });
    const before = store.get(task.id);
    await expect(
      store.update(task.id, { subject: "leaked", description: "leaked", metadata: { leaked: true }, blockedBy: [999] }),
    ).rejects.toThrow(/does not exist/);
    expect(store.get(task.id)).toEqual(before);
    await store.save();
    expect((await TaskStore.load(store.filePath)).get(task.id)).toEqual(before);
  });

  it("rolls back create, nextId, and delete when persistence fails", async () => {
    const original = await freshStore();
    await original.create({ subject: "existing", description: "" });
    const beforeDisk = await readFile(original.filePath, "utf8");
    let failWrites = true;
    const store = await TaskStore.load(original.filePath, async () => {
      if (failWrites) throw new Error("simulated write failure");
    });
    const before = store.list();

    await expect(store.create({ subject: "not saved", description: "" })).rejects.toThrow(/simulated write failure/);
    expect(store.list()).toEqual(before);
    await expect(store.delete(1)).rejects.toThrow(/simulated write failure/);
    expect(store.list()).toEqual(before);
    expect(await readFile(original.filePath, "utf8")).toBe(beforeDisk);

    failWrites = false;
    expect((await store.create({ subject: "saved", description: "" })).id).toBe(2);
  });
});

describe("dependencies", () => {
  it("refuses unknown references and self-reference", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    await expect(store.update(task.id, { blockedBy: [999] })).rejects.toThrow(/does not exist/);
    await expect(store.update(task.id, { blockedBy: [task.id] })).rejects.toThrow(/itself/);
    await expect(store.create({ subject: "b", description: "", blockedBy: [task.id, 999] })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("refuses cycles", async () => {
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "", blockedBy: [a.id] });
    const c = await store.create({ subject: "c", description: "", blockedBy: [b.id] });
    await expect(store.update(a.id, { blockedBy: [c.id] })).rejects.toThrow(/cycle/);
    await expect(store.update(b.id, { blockedBy: [b.id] })).rejects.toThrow(/itself/);
    // Direct two-node cycle.
    await expect(store.update(a.id, { blockedBy: [b.id] })).rejects.toThrow(/cycle/);
  });

  it("gates entering in_progress on completed dependencies", async () => {
    const store = await freshStore();
    const dep = await store.create({ subject: "dep", description: "" });
    const task = await store.create({ subject: "main", description: "", blockedBy: [dep.id] });
    await expect(store.update(task.id, { status: "in_progress" })).rejects.toThrow(/not completed/);
    await store.update(dep.id, { status: "completed" });
    const started = await store.update(task.id, { status: "in_progress" });
    expect(started.status).toBe("in_progress");
  });

  it("rejects replacing dependencies of an in-progress task with incomplete tasks", async () => {
    const store = await freshStore();
    const completed = await store.create({ subject: "done", description: "" });
    const pending = await store.create({ subject: "open", description: "" });
    await store.update(completed.id, { status: "completed" });
    const task = await store.create({ subject: "main", description: "", blockedBy: [completed.id] });
    await store.update(task.id, { status: "in_progress" });

    await expect(store.update(task.id, { blockedBy: [pending.id] })).rejects.toThrow(
      /Task #3 cannot remain in_progress.*#2/,
    );
    expect(store.get(task.id)?.blockedBy).toEqual([completed.id]);
  });

  it("rejects reopening a dependency required by an in-progress task", async () => {
    const store = await freshStore();
    const dep = await store.create({ subject: "dep", description: "" });
    // Create the dependent before completing the dependency: completing every
    // task would make the store all-completed, and the next create would
    // atomically reset to a fresh state instead of appending.
    const task = await store.create({ subject: "main", description: "", blockedBy: [dep.id] });
    await store.update(dep.id, { status: "completed" });
    await store.update(task.id, { status: "in_progress" });

    await expect(store.update(dep.id, { status: "pending" })).rejects.toThrow(
      /Task #2 cannot remain in_progress.*#1/,
    );
    expect(store.get(dep.id)?.status).toBe("completed");
  });

  it("refuses to delete tasks that are referenced", async () => {
    const store = await freshStore();
    const dep = await store.create({ subject: "dep", description: "" });
    const task = await store.create({ subject: "main", description: "", blockedBy: [dep.id] });
    await expect(store.delete(dep.id)).rejects.toThrow(/#2/);
    await store.delete(task.id);
    await store.delete(dep.id);
    expect(store.list()).toEqual([]);
  });
});

describe("attempt limits", () => {
  it("creates tasks with attempt 0 and default maxAttempts 9", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    expect(task.attempt).toBe(0);
    expect(task.maxAttempts).toBe(9);
    expect(store.get(task.id)).toMatchObject({ attempt: 0, maxAttempts: 9 });
    expect(store.list()[0]).toMatchObject({ attempt: 0, maxAttempts: 9 });
  });

  it("accepts a per-task maxAttempts override", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "", maxAttempts: 2 });
    expect(task).toMatchObject({ attempt: 0, maxAttempts: 2 });
  });

  it.each([0, -1, -9, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    "rejects invalid maxAttempts on create: %s",
    async (maxAttempts) => {
      const store = await freshStore();
      await expect(store.create({ subject: "a", description: "", maxAttempts: maxAttempts as number })).rejects.toThrow(
        /maxAttempts/,
      );
      expect(store.list()).toEqual([]);
    },
  );

  it("rejects non-numeric maxAttempts on create", async () => {
    const store = await freshStore();
    await expect(
      store.create({ subject: "a", description: "", maxAttempts: "3" as unknown as number }),
    ).rejects.toThrow(/maxAttempts/);
  });

  it("keeps per-task limits independent", async () => {
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "", maxAttempts: 1 });
    const b = await store.create({ subject: "b", description: "", maxAttempts: 3 });
    await store.update(a.id, { status: "in_progress" });
    expect(store.get(a.id)).toMatchObject({ attempt: 1, maxAttempts: 1 });
    expect(store.get(b.id)).toMatchObject({ attempt: 0, maxAttempts: 3 });
    await expect(store.update(a.id, { status: "completed" })).resolves.toMatchObject({ attempt: 1 });
    await expect(store.update(a.id, { status: "in_progress" })).rejects.toThrow(
      "Task #1 has reached the maximum number of attempts (1).",
    );
    const started = await store.update(b.id, { status: "in_progress" });
    expect(started).toMatchObject({ attempt: 1, maxAttempts: 3 });
  });

  it("follows the entry transition matrix", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    // pending -> in_progress increments.
    expect((await store.update(task.id, { status: "in_progress" })).attempt).toBe(1);
    // in_progress -> in_progress does not increment.
    expect((await store.update(task.id, { status: "in_progress" })).attempt).toBe(1);
    // in_progress -> completed does not increment.
    expect((await store.update(task.id, { status: "completed" })).attempt).toBe(1);
    // completed -> completed does not increment.
    expect((await store.update(task.id, { status: "completed" })).attempt).toBe(1);
    // completed -> in_progress increments.
    expect((await store.update(task.id, { status: "in_progress" })).attempt).toBe(2);
    // in_progress -> pending does not increment.
    expect((await store.update(task.id, { status: "pending" })).attempt).toBe(2);
    // pending -> pending does not increment.
    expect((await store.update(task.id, { status: "pending" })).attempt).toBe(2);
    // pending -> completed does not increment.
    expect((await store.update(task.id, { status: "completed" })).attempt).toBe(2);
    // completed -> pending does not increment.
    expect((await store.update(task.id, { status: "pending" })).attempt).toBe(2);
    // Non-status patch on in_progress does not increment.
    await store.update(task.id, { status: "in_progress" });
    expect((await store.update(task.id, { subject: "renamed" })).attempt).toBe(3);
    expect(store.get(task.id)?.subject).toBe("renamed");
  });

  it("rejects entry when exhausted with an exact message and preserves all state atomically", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "original", description: "before", maxAttempts: 1 });
    await store.update(task.id, { status: "in_progress" });
    await store.update(task.id, { status: "completed" });
    const before = store.get(task.id);
    expect(before).toMatchObject({ attempt: 1, maxAttempts: 1, status: "completed" });
    const beforeDisk = await readFile(store.filePath, "utf8");

    await expect(
      store.update(task.id, {
        status: "in_progress",
        subject: "leaked",
        description: "leaked",
        metadata: { leaked: true },
      }),
    ).rejects.toThrow("Task #1 has reached the maximum number of attempts (1).");

    const after = store.get(task.id);
    expect(after).toEqual(before);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.subject).toBe("original");
    expect(after?.metadata).toEqual({});
    await store.save();
    expect(await readFile(store.filePath, "utf8")).toBe(beforeDisk);
    expect((await TaskStore.load(store.filePath)).get(task.id)).toEqual(before);
  });

  it("allows entry while attempt is below the cap and rejects once it reaches the cap", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "", maxAttempts: 2 });
    await store.update(task.id, { status: "in_progress" });
    await store.update(task.id, { status: "completed" });
    await store.update(task.id, { status: "in_progress" });
    expect(store.get(task.id)?.attempt).toBe(2);
    await store.update(task.id, { status: "completed" });
    await expect(store.update(task.id, { status: "in_progress" })).rejects.toThrow(
      "Task #1 has reached the maximum number of attempts (2).",
    );
  });

  it("excludes attempt and maxAttempts from TaskUpdate with no workaround", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    await expect(store.update(task.id, { attempt: 5 } as unknown as Record<string, never> as never)).rejects.toThrow(
      /attempt/,
    );
    await expect(
      store.update(task.id, { maxAttempts: 5 } as unknown as Record<string, never> as never),
    ).rejects.toThrow(/maxAttempts/);
    expect(store.get(task.id)).toMatchObject({ attempt: 0, maxAttempts: 9 });
  });

  it("preserves dependency gating alongside exhaustion", async () => {
    const store = await freshStore();
    const dep = await store.create({ subject: "dep", description: "" });
    const task = await store.create({ subject: "main", description: "", blockedBy: [dep.id], maxAttempts: 1 });
    await expect(store.update(task.id, { status: "in_progress" })).rejects.toThrow(/not completed/);
    expect(store.get(task.id)?.attempt).toBe(0);
    await store.update(dep.id, { status: "completed" });
    await store.update(task.id, { status: "in_progress" });
    expect(store.get(task.id)?.attempt).toBe(1);
  });

  it("rejects persisted tasks with missing or invalid attempt/maxAttempts", async () => {
    const missingAttempt = persistedTask(1);
    delete (missingAttempt as Record<string, unknown>).attempt;
    await expect(
      TaskStore.load(await persistedPath({ version: 1, nextId: 2, tasks: [missingAttempt] })),
    ).rejects.toThrow(/attempt/);

    const missingMax = persistedTask(1);
    delete (missingMax as Record<string, unknown>).maxAttempts;
    await expect(
      TaskStore.load(await persistedPath({ version: 1, nextId: 2, tasks: [missingMax] })),
    ).rejects.toThrow(/maxAttempts/);

    for (const attempt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0" as unknown as number]) {
      await expect(
        TaskStore.load(await persistedPath({ version: 1, nextId: 2, tasks: [persistedTask(1, { attempt })] })),
      ).rejects.toThrow(/attempt/);
    }
    for (const maxAttempts of [0, -2, 1.5, Number.MAX_SAFE_INTEGER + 1, "9" as unknown as number]) {
      await expect(
        TaskStore.load(await persistedPath({ version: 1, nextId: 2, tasks: [persistedTask(1, { maxAttempts })] })),
      ).rejects.toThrow(/maxAttempts/);
    }
    await expect(
      TaskStore.load(await persistedPath({ version: 1, nextId: 2, tasks: [persistedTask(1, { attempt: 10 })] })),
    ).rejects.toThrow(/attempt/);
  });

  it("round-trips attempt counters through the persisted envelope", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "", maxAttempts: 2 });
    await store.update(task.id, { status: "in_progress" });
    const data = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(data.tasks[0]).toMatchObject({ attempt: 1, maxAttempts: 2 });
    expect((await TaskStore.load(store.filePath)).get(task.id)).toMatchObject({ attempt: 1, maxAttempts: 2 });
  });
});

describe("renamed prefix guard", () => {
  it("rejects stale prefix on create", async () => {
    const store = await freshStore();
    await expect(
      store.create({ subject: "a", description: "", prefix: "api" } as unknown as { subject: string; description: string }),
    ).rejects.toThrow("`prefix` was renamed to `assignee`; use `assignee`.");
    expect(store.list()).toEqual([]);
  });

  it("rejects stale prefix on update", async () => {
    const store = await freshStore();
    const task = await store.create({ subject: "a", description: "" });
    await expect(
      store.update(task.id, { prefix: "api" } as unknown as { subject: string }),
    ).rejects.toThrow("`prefix` was renamed to `assignee`; use `assignee`.");
    expect(store.get(task.id)).toMatchObject({ subject: "a" });
  });

  it("rejects persisted stale prefix", async () => {
    await expect(
      TaskStore.load(await persistedPath({ version: 1, nextId: 2, tasks: [persistedTask(1, { prefix: "api" })] })),
    ).rejects.toThrow(/unknown key: prefix/);
  });
});
