import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/store.js";
import { buildWidgetLines, formatActiveTotal, formatMillisDuration, formatTaskLine } from "../src/widget.js";
import type { Task } from "../src/types.js";

const dirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshStore(): Promise<TaskStore> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-timing-"));
  dirs.push(dir);
  return new TaskStore(join(dir, "tasks.json"));
}

function widgetTask(overrides: Partial<Task> & { id: number; subject: string }): Task {
  return {
    description: "",
    status: "pending",
    attempt: 0,
    maxAttempts: 9,
    blockedBy: [],
    metadata: {},
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

describe("per-attempt timing transitions", () => {
  it("starts the attempt timer at zero only on a real entry into in_progress", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" });
    expect(created.startedAt).toBeUndefined();

    const started = await store.update(created.id, { status: "in_progress" });
    expect(started.startedAt).toBe(new Date(T0).toISOString());

    // Staying in_progress (explicit status or field patch) must not reset the timer.
    vi.setSystemTime(T0 + 30_000);
    const stayed = await store.update(created.id, { status: "in_progress", subject: "renamed" });
    expect(stayed.startedAt).toBe(new Date(T0).toISOString());
    const patched = await store.update(created.id, { description: "edit" });
    expect(patched.startedAt).toBe(new Date(T0).toISOString());

    const line = formatTaskLine(store.get(created.id) as Task, T0 + 90_000);
    expect(line.endsWith("renamed 1m 30s")).toBe(true);
  });

  it("freezes the duration on completion and replaces it after rework", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" });
    await store.update(created.id, { status: "in_progress" });

    vi.setSystemTime(T0 + 65_000);
    const done = await store.update(created.id, { status: "completed" });
    expect(done.tookMs).toBe(65_000);
    expect(done.startedAt).toBeUndefined();
    expect(formatTaskLine(done, T0 + 65_000)).toContain("1m 5s");
    expect(formatTaskLine(done, T0 + 65_000)).not.toContain("took");

    // Frozen: rendering later does not advance the completed duration.
    expect(formatTaskLine(store.get(created.id) as Task, T0 + 600_000)).toContain("1m 5s");

    // Rework starts a new zeroed attempt showing `0s`, and the next completion overwrites the frozen duration.
    vi.setSystemTime(T0 + 600_000);
    const reworked = await store.update(created.id, { status: "in_progress" });
    expect(reworked.tookMs).toBeUndefined();
    expect(formatTaskLine(reworked, T0 + 600_000)).not.toContain("took");
    expect(formatTaskLine(reworked, T0 + 600_000)).toBe(`  ■ #1 (2/9) a 0s`);

    vi.setSystemTime(T0 + 630_000);
    const redone = await store.update(created.id, { status: "completed" });
    expect(redone.tookMs).toBe(30_000);
    expect(formatTaskLine(redone, T0 + 630_000)).toContain("30s");
    expect(formatTaskLine(redone, T0 + 630_000)).not.toContain("took");
  });
});

describe("global union time", () => {
  it("runs while any task is active without double-counting concurrency, stops when idle, and resumes", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const a = await store.create({ subject: "a", description: "" });
    const b = await store.create({ subject: "b", description: "" });
    const c = await store.create({ subject: "c", description: "" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 0 });

    await store.update(a.id, { status: "in_progress" });
    expect(store.activeTiming().activeSince).toBe(new Date(T0).toISOString());

    // Concurrent work overlaps: 60s with two active tasks counts once.
    vi.setSystemTime(T0 + 10_000);
    await store.update(b.id, { status: "in_progress" });
    vi.setSystemTime(T0 + 70_000);
    await store.update(a.id, { status: "completed" });
    // One task still active, so the period continues and nothing is banked yet.
    expect(store.activeTiming().totalActiveMs).toBe(0);

    vi.setSystemTime(T0 + 100_000);
    await store.update(b.id, { status: "completed" });
    // Union is T0..T0+100s counted once.
    expect(store.activeTiming()).toEqual({ totalActiveMs: 100_000 });

    // Idle time does not accumulate (c stays pending, so the list never resets).
    vi.setSystemTime(T0 + 500_000);
    // Store holds completed tasks plus pending c, so no reset; total preserved.
    expect(store.activeTiming()).toEqual({ totalActiveMs: 100_000 });

    // Restarting work resumes from the accumulated value; rework contributes.
    await store.update(c.id, { status: "in_progress" });
    vi.setSystemTime(T0 + 530_000);
    await store.update(c.id, { status: "completed" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 130_000 });
  });

  it("keeps the header total frozen while idle across reloads", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" });
    await store.update(created.id, { status: "in_progress" });
    vi.setSystemTime(T0 + 20_000);
    await store.update(created.id, { status: "completed" });
    expect(store.activeTiming()).toEqual({ totalActiveMs: 20_000 });

    vi.setSystemTime(T0 + 999_000);
    const reloaded = await TaskStore.load(store.filePath);
    expect(reloaded.activeTiming()).toEqual({ totalActiveMs: 20_000 });
    const lines = buildWidgetLines(reloaded.list(), T0 + 999_000, reloaded.activeTiming());
    expect(lines[0]).toBe("● 1 task (1 done) 20s");
    expect(lines[1]).toContain("20s");
    expect(lines[1]).not.toContain("took");
  });
});

describe("persistence and reload", () => {
  it("persists attempt timing and global timing across reloads", async () => {
    vi.setSystemTime(T0);
    const store = await freshStore();
    const created = await store.create({ subject: "a", description: "" });
    await store.update(created.id, { status: "in_progress" });
    const data = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(data.tasks[0].startedAt).toBe(new Date(T0).toISOString());
    expect(data.activeSince).toBe(new Date(T0).toISOString());
    expect(data.totalActiveMs).toBe(0);

    vi.setSystemTime(T0 + 45_000);
    const reloaded = await TaskStore.load(store.filePath);
    const task = reloaded.get(created.id) as Task;
    // Running timers survive reload without resetting to zero.
    expect(task.startedAt).toBe(new Date(T0).toISOString());
    expect(formatTaskLine(task, T0 + 45_000)).toContain("45s");
    expect(reloaded.activeTiming().activeSince).toBe(new Date(T0).toISOString());
  });

  it("starts a legacy in_progress task without startedAt at load time", async () => {
    const store = await freshStore();
    const { writeFile } = await import("node:fs/promises");
    vi.setSystemTime(T0 + 100_000);
    await writeFile(
      store.filePath,
      JSON.stringify({
        version: 1,
        nextId: 2,
        totalActiveMs: 0,
        tasks: [
          {
            id: 1,
            subject: "a",
            description: "",
            status: "in_progress",
            attempt: 1,
            maxAttempts: 9,
            blockedBy: [],
            metadata: {},
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const reloaded = await TaskStore.load(store.filePath);
    const loadIso = new Date(T0 + 100_000).toISOString();
    const loaded = reloaded.get(1) as Task;
    // No invented pre-upgrade duration: the attempt starts at load time,
    // matching the global activeSince load-time behavior.
    expect(loaded.startedAt).toBe(loadIso);
    expect(reloaded.activeTiming().activeSince).toBe(loadIso);
    expect(formatTaskLine(loaded, T0 + 100_000)).toBe("  ■ #1 (1/9) a 0s");
    expect(formatTaskLine(loaded, T0 + 190_000)).toContain("1m 30s");
  });

  it("rejects invalid persisted timing fields", async () => {
    const store = await freshStore();
    const { writeFile } = await import("node:fs/promises");
    const base = {
      version: 1,
      nextId: 2,
      totalActiveMs: 0,
      tasks: [
        {
          id: 1,
          subject: "a",
          description: "",
          status: "pending",
          attempt: 0,
          maxAttempts: 9,
          blockedBy: [],
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await writeFile(store.filePath, JSON.stringify({ ...base, totalActiveMs: -1 }));
    await expect(TaskStore.load(store.filePath)).rejects.toThrow(/totalActiveMs/);
    await writeFile(store.filePath, JSON.stringify({ ...base, activeSince: "not-a-date" }));
    await expect(TaskStore.load(store.filePath)).rejects.toThrow(/activeSince/);
    await writeFile(
      store.filePath,
      JSON.stringify({ ...base, tasks: [{ ...base.tasks[0], tookMs: -5 }] }),
    );
    await expect(TaskStore.load(store.filePath)).rejects.toThrow(/tookMs/);
    await writeFile(
      store.filePath,
      JSON.stringify({ ...base, tasks: [{ ...base.tasks[0], startedAt: "bad" }] }),
    );
    await expect(TaskStore.load(store.filePath)).rejects.toThrow(/startedAt/);
  });
});

describe("timing formatting", () => {
  it("formats millisecond durations with an explicit zero", () => {
    expect(formatMillisDuration(0)).toBe("");
    expect(formatMillisDuration(90_000)).toBe("1m 30s");
    expect(formatMillisDuration(-1)).toBe("");
  });

  it("shows the global total only after timing has started", () => {
    const header = buildWidgetLines([widgetTask({ id: 1, subject: "a" })], T0, { totalActiveMs: 0 })[0];
    expect(header).toBe("● 1 task (0 done)");
    const started = buildWidgetLines([widgetTask({ id: 1, subject: "a", attempt: 1 })], T0, { totalActiveMs: 0 })[0];
    expect(started).toBe("● 1 task (0 done) 0s");
    const running = buildWidgetLines(
      [widgetTask({ id: 1, subject: "a", status: "in_progress", startedAt: new Date(T0).toISOString() })],
      T0 + 5_000,
      { totalActiveMs: 60_000, activeSince: new Date(T0).toISOString() },
    )[0];
    expect(running).toBe("● 1 task (0 done) 1m 5s");
    expect(formatActiveTotal(undefined, [], T0)).toBe("0s");
  });

  it("shows zero durations explicitly and hides pending durations", () => {
    expect(formatTaskLine(widgetTask({ id: 1, subject: "a" }), T0)).toBe("  ■ #1 (0/9) a");
    expect(
      formatTaskLine(widgetTask({ id: 1, subject: "a", status: "completed", tookMs: 0 }), T0),
    ).toBe("  ■ #1 (0/9) a 0s");
  });
});
