import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import registerExtension from "../src/index.js";
import { taskFilePath } from "../src/store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Captured {
  tools: Map<string, any>;
  turnStart: ((event: unknown, ctx: any) => Promise<void> | void) | undefined;
}

function capture(): Captured & { pi: any } {
  const captured: Captured = { tools: new Map(), turnStart: undefined };
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) => {
      if (event === "turn_start") captured.turnStart = handler;
    },
    registerTool: (tool: any) => {
      captured.tools.set(tool.name, tool);
    },
    registerCommand: (_name: string, _command: unknown) => {},
  };
  return Object.assign(captured, { pi });
}

async function freshCtx(sessionId = "tools-session") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-task-tools-"));
  dirs.push(cwd);
  const widgets: Array<{ key: string; content: unknown }> = [];
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setWidget: (key: string, content: unknown) => {
        widgets.push({ key, content });
      },
    },
  };
  return { cwd, ctx, widgets };
}

describe("tool registration", () => {
  it("registers exactly the five task tools", () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    expect([...tools.keys()].sort()).toEqual(["TaskCreate", "TaskDelete", "TaskGet", "TaskList", "TaskUpdate"]);
  });

  it("registers a turn_start handler", () => {
    const captured = capture();
    registerExtension(captured.pi);
    expect(typeof captured.turnStart).toBe("function");
  });

  it("marks mutation tools for sequential execution", () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    expect(tools.get("TaskCreate").executionMode).toBe("sequential");
    expect(tools.get("TaskUpdate").executionMode).toBe("sequential");
    expect(tools.get("TaskDelete").executionMode).toBe("sequential");
    expect(tools.get("TaskGet").executionMode).toBeUndefined();
    expect(tools.get("TaskList").executionMode).toBeUndefined();
  });
});

describe("tool behavior", () => {
  it("creates, gets, lists, updates, and deletes through the tools", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();

    const created = await tools.get("TaskCreate").execute("c1", { subject: "Work", description: "do things" }, undefined, undefined, ctx);
    expect(created.isError).toBeUndefined();
    expect(JSON.parse(created.content[0].text)).toMatchObject({ id: 1, subject: "Work", status: "pending" });
    expect(created.content[0].text).not.toContain("Created task");

    const listed = await tools.get("TaskList").execute("c2", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)).toHaveLength(1);

    const gotten = await tools.get("TaskGet").execute("c3", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text).subject).toBe("Work");

    const updated = await tools.get("TaskUpdate").execute("c4", { id: 1, status: "completed" }, undefined, undefined, ctx);
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text)).toEqual({ id: 1, status: "completed" });
    expect(updated.content[0].text).not.toContain("Updated task");

    const filtered = await tools.get("TaskList").execute("c5", { status: "completed" }, undefined, undefined, ctx);
    expect(JSON.parse(filtered.content[0].text)).toHaveLength(1);

    const deleted = await tools.get("TaskDelete").execute("c6", { id: 1 }, undefined, undefined, ctx);
    expect(deleted.isError).toBeUndefined();
    expect(JSON.parse(deleted.content[0].text)).toEqual({ id: 1 });
    expect(deleted.content[0].text).not.toContain("Deleted task");
  });

  it("returns clear error results for invalid and not-found operations", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();

    const missing = await tools.get("TaskGet").execute("c1", { id: 5 }, undefined, undefined, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("does not exist");

    const invalid = await tools.get("TaskDelete").execute("c2", { id: 0 }, undefined, undefined, ctx);
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("positive safe integer");

    const badDep = await tools.get("TaskCreate").execute(
      "c3",
      { subject: "x", description: "", blockedBy: [9] },
      undefined,
      undefined,
      ctx,
    );
    expect(badDep.isError).toBe(true);

    const gated = await tools.get("TaskCreate").execute("c4", { subject: "dep", description: "" }, undefined, undefined, ctx);
    expect(gated.isError).toBeUndefined();
    const blocked = await tools.get("TaskCreate").execute(
      "c5",
      { subject: "main", description: "", blockedBy: [1] },
      undefined,
      undefined,
      ctx,
    );
    expect(blocked.isError).toBeUndefined();
    const early = await tools.get("TaskUpdate").execute("c6", { id: 2, status: "in_progress" }, undefined, undefined, ctx);
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain("not completed");
  });

  it("requires description, discourages implicit colors, and constrains every ID schema to safe integers", () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const create = tools.get("TaskCreate").parameters as any;
    const update = tools.get("TaskUpdate").parameters as any;
    expect(create.required).toContain("description");
    expect(create.properties.color.description).toContain("unless the user explicitly requests");
    expect(update.properties.color.description).toContain("unless the user explicitly requests");
    expect(create.properties.blockedBy.items.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(update.properties.id.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(update.properties.blockedBy.items.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(tools.get("TaskGet").parameters.properties.id.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(tools.get("TaskDelete").parameters.properties.id.maximum).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects unsafe integer IDs at runtime", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    const result = await tools
      .get("TaskGet")
      .execute("c1", { id: Number.MAX_SAFE_INTEGER + 1 }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("positive safe integer");
  });

  it("returns pure-JSON success payloads: full task for TaskCreate, input echo for TaskUpdate", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();

    const created = await tools
      .get("TaskCreate")
      .execute("c1", { subject: "Work", description: "do things" }, undefined, undefined, ctx);
    expect(created.isError).toBeUndefined();
    const createdTask = JSON.parse(created.content[0].text);
    expect(createdTask).toMatchObject({ id: 1, subject: "Work", description: "do things", status: "pending" });

    const updated = await tools
      .get("TaskUpdate")
      .execute("c2", { id: 1, subject: "Renamed" }, undefined, undefined, ctx);
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text)).toEqual({ id: 1, subject: "Renamed" });
    expect("description" in JSON.parse(updated.content[0].text)).toBe(false);

    const gotten = await tools.get("TaskGet").execute("c3", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text)).toMatchObject({ id: 1, subject: "Renamed", description: "do things" });
  });

  it("echoes only supplied TaskUpdate fields, preserving null while omitting absent ones", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();

    await tools
      .get("TaskCreate")
      .execute("c1", { subject: "Work", description: "original" }, undefined, undefined, ctx);
    const updated = await tools
      .get("TaskUpdate")
      .execute("c2", { id: 1, subject: "Renamed", assignee: null }, undefined, undefined, ctx);
    expect(updated.isError).toBeUndefined();
    const echoed = JSON.parse(updated.content[0].text);
    expect(echoed).toEqual({ id: 1, subject: "Renamed", assignee: null });
    expect("description" in echoed).toBe(false);
    expect("color" in echoed).toBe(false);
  });

  it("preserves explicit null through TaskUpdate so assignee/color are removed", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();

    await tools
      .get("TaskCreate")
      .execute(
        "c1",
        { subject: "Labeled", description: "details", assignee: "api", color: "red" },
        undefined,
        undefined,
        ctx,
      );
    const updated = await tools
      .get("TaskUpdate")
      .execute("c2", { id: 1, assignee: null, color: null }, undefined, undefined, ctx);
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text)).toEqual({ id: 1, assignee: null, color: null });

    const gotten = await tools.get("TaskGet").execute("c3", { id: 1 }, undefined, undefined, ctx);
    const stored = JSON.parse(gotten.content[0].text);
    expect("assignee" in stored).toBe(false);
    expect("color" in stored).toBe(false);
  });

  it("preserves an all-completed file across turn_start and lazily cleans on TaskCreate", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const { tools } = captured;
    const { cwd, ctx } = await freshCtx();
    const path = taskFilePath(cwd, "tools-session");

    await tools.get("TaskCreate").execute("c1", { subject: "a", description: "" }, undefined, undefined, ctx);
    await tools.get("TaskUpdate").execute("c2", { id: 1, status: "completed" }, undefined, undefined, ctx);
    expect(existsSync(path)).toBe(true);

    await captured.turnStart?.({ type: "turn_start" }, ctx);
    expect(existsSync(path)).toBe(true);

    const listed = await tools.get("TaskList").execute("c3", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)).toHaveLength(1);

    const recreated = await tools.get("TaskCreate").execute("c4", { subject: "b", description: "" }, undefined, undefined, ctx);
    expect(recreated.isError).toBeUndefined();
    expect(JSON.parse(recreated.content[0].text)).toMatchObject({ id: 1, subject: "b" });

    const after = await tools.get("TaskList").execute("c5", {}, undefined, undefined, ctx);
    expect(JSON.parse(after.content[0].text).map((task: { subject: string }) => task.subject)).toEqual(["b"]);
  });

  it("preserves the completed file and widget when a reset TaskCreate fails validation", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const { tools } = captured;
    const { cwd, ctx, widgets } = await freshCtx();
    const path = taskFilePath(cwd, "tools-session");

    await tools.get("TaskCreate").execute("c1", { subject: "a", description: "" }, undefined, undefined, ctx);
    await tools.get("TaskUpdate").execute("c2", { id: 1, status: "completed" }, undefined, undefined, ctx);
    const beforeDisk = await readFile(path, "utf8");
    const widgetCount = widgets.length;

    const badSubject = await tools
      .get("TaskCreate")
      .execute("c3", { subject: "  ", description: "" }, undefined, undefined, ctx);
    expect(badSubject.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
    expect(widgets.length).toBe(widgetCount);

    const staleDep = await tools
      .get("TaskCreate")
      .execute("c4", { subject: "b", description: "", blockedBy: [1] }, undefined, undefined, ctx);
    expect(staleDep.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
    expect(widgets.length).toBe(widgetCount);

    const listed = await tools.get("TaskList").execute("c5", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text).map((task: { subject: string }) => task.subject)).toEqual(["a"]);

    const recreated = await tools
      .get("TaskCreate")
      .execute("c6", { subject: "b", description: "" }, undefined, undefined, ctx);
    expect(recreated.isError).toBeUndefined();
    expect(JSON.parse(recreated.content[0].text)).toMatchObject({ id: 1, subject: "b" });
  });

  it("appends with the existing nextId when any task is still active", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const { tools } = captured;
    const { ctx } = await freshCtx();

    await tools.get("TaskCreate").execute("c1", { subject: "a", description: "" }, undefined, undefined, ctx);
    await tools.get("TaskCreate").execute("c2", { subject: "b", description: "" }, undefined, undefined, ctx);
    await tools.get("TaskUpdate").execute("c3", { id: 1, status: "completed" }, undefined, undefined, ctx);
    await captured.turnStart?.({ type: "turn_start" }, ctx);

    const recreated = await tools.get("TaskCreate").execute("c4", { subject: "c", description: "" }, undefined, undefined, ctx);
    expect(recreated.isError).toBeUndefined();
    expect(JSON.parse(recreated.content[0].text)).toMatchObject({ id: 3, subject: "c" });

    const listed = await tools.get("TaskList").execute("c5", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)).toHaveLength(3);
  });
});

describe("attempt limits via tools", () => {
  it("creates with attempt 0 and default maxAttempts 9, and surfaces them in every payload", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    const created = await tools.get("TaskCreate").execute("c1", { subject: "W", description: "d" }, undefined, undefined, ctx);
    expect(created.isError).toBeUndefined();
    const createdTask = JSON.parse(created.content[0].text);
    expect(createdTask).toMatchObject({ attempt: 0, maxAttempts: 9 });

    const gotten = await tools.get("TaskGet").execute("c2", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text)).toMatchObject({ attempt: 0, maxAttempts: 9 });

    const listed = await tools.get("TaskList").execute("c3", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)[0]).toMatchObject({ attempt: 0, maxAttempts: 9 });
  });

  it("accepts a per-task maxAttempts override and validates it", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    const created = await tools
      .get("TaskCreate")
      .execute("c1", { subject: "W", description: "d", maxAttempts: 2 }, undefined, undefined, ctx);
    expect(created.isError).toBeUndefined();
    expect(JSON.parse(created.content[0].text)).toMatchObject({
      attempt: 0,
      maxAttempts: 2,
    });
    for (const maxAttempts of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const bad = await tools
        .get("TaskCreate")
        .execute("bad", { subject: "W", description: "d", maxAttempts }, undefined, undefined, ctx);
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/maxAttempts/);
    }
  });

  it("exposes maxAttempts in the TaskCreate schema", () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const create = tools.get("TaskCreate").parameters as any;
    expect(create.properties.maxAttempts).toBeDefined();
    expect(create.properties.maxAttempts.minimum).toBe(1);
    expect(create.properties.maxAttempts.maximum).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("excludes attempt and maxAttempts from the TaskUpdate schema and rejects them at runtime", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const update = tools.get("TaskUpdate").parameters as any;
    expect("attempt" in update.properties).toBe(false);
    expect("maxAttempts" in update.properties).toBe(false);
    const { ctx } = await freshCtx();
    await tools.get("TaskCreate").execute("c1", { subject: "W", description: "d" }, undefined, undefined, ctx);
    for (const patch of [{ id: 1, attempt: 1 }, { id: 1, maxAttempts: 1 }]) {
      const result = await tools.get("TaskUpdate").execute("c2", patch, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/[Aa]ttempt/);
    }
    const gotten = await tools.get("TaskGet").execute("c3", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text)).toMatchObject({ attempt: 0, maxAttempts: 9 });
  });

  it("exposes appendLog and preserves description while appending a timestamped note", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const update = tools.get("TaskUpdate");
    const schema = update.parameters as any;
    expect(schema.properties.appendLog).toBeDefined();
    expect(schema.properties.description.description).toContain("use appendLog instead");
    expect(update.description).toContain("appendLog");

    const { ctx } = await freshCtx();
    await tools.get("TaskCreate").execute("c1", { subject: "Work", description: "original" }, undefined, undefined, ctx);
    const result = await update.execute("c2", { id: 1, appendLog: "Needs another pass" }, undefined, undefined, ctx);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 1, appendLog: "Needs another pass" });
    const stored = JSON.parse((await tools.get("TaskGet").execute("c3", { id: 1 }, undefined, undefined, ctx)).content[0].text);
    expect(stored.description).toBe("original");
    expect(stored.log).toHaveLength(1);
    expect(stored.log[0].timestamp).toMatch(/Z$/);
    expect(stored.log[0].message).toBe("Needs another pass");
  });

  it("echoes the update input as pure JSON and increments attempt immediately on entry", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    await tools.get("TaskCreate").execute("c1", { subject: "Work", description: "d" }, undefined, undefined, ctx);
    const updated = await tools.get("TaskUpdate").execute("c2", { id: 1, status: "in_progress" }, undefined, undefined, ctx);
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text)).toEqual({ id: 1, status: "in_progress" });
    const stored = JSON.parse((await tools.get("TaskGet").execute("c3", { id: 1 }, undefined, undefined, ctx)).content[0].text);
    expect(stored).toMatchObject({ attempt: 1, maxAttempts: 9, status: "in_progress" });
  });

  it("rejects exhausted entry with the exact message and preserves persisted state", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    await tools
      .get("TaskCreate")
      .execute("c1", { subject: "Work", description: "d", maxAttempts: 1 }, undefined, undefined, ctx);
    await tools.get("TaskUpdate").execute("c2", { id: 1, status: "in_progress" }, undefined, undefined, ctx);
    await tools.get("TaskUpdate").execute("c3", { id: 1, status: "completed" }, undefined, undefined, ctx);
    const before = await tools.get("TaskGet").execute("c4", { id: 1 }, undefined, undefined, ctx);
    const rejected = await tools
      .get("TaskUpdate")
      .execute("c5", { id: 1, status: "in_progress", subject: "leaked" }, undefined, undefined, ctx);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toBe("Task #1 has reached the maximum number of attempts (1).");
    const after = await tools.get("TaskGet").execute("c6", { id: 1 }, undefined, undefined, ctx);
    expect(after.content[0].text).toBe(before.content[0].text);
  });
});

describe("renamed prefix guard via tools", () => {
  it("rejects stale prefix on TaskCreate", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    const result = await tools
      .get("TaskCreate")
      .execute("c1", { subject: "W", description: "d", prefix: "api" }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("`prefix` was renamed to `assignee`; use `assignee`.");
  });

  it("rejects stale prefix on TaskUpdate", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    await tools.get("TaskCreate").execute("c1", { subject: "W", description: "d" }, undefined, undefined, ctx);
    const result = await tools
      .get("TaskUpdate")
      .execute("c2", { id: 1, prefix: "api" }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("`prefix` was renamed to `assignee`; use `assignee`.");
  });
});
