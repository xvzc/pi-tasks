import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerExtension from "../src/index.js";
import { taskFilePath } from "../src/store.js";

const dirs: string[] = [];
let savedAgentDir: string | undefined;
let hadAgentDir = false;

beforeEach(async () => {
  hadAgentDir = "PI_CODING_AGENT_DIR" in process.env;
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-task-tools-agent-"));
  dirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  if (hadAgentDir) process.env.PI_CODING_AGENT_DIR = savedAgentDir as string;
  else delete process.env.PI_CODING_AGENT_DIR;
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Captured {
  tools: Map<string, any>;
  turnStart: ((event: unknown, ctx: any) => Promise<void> | void) | undefined;
  beforeAgentStart:
    ((event: any) => { systemPrompt: string } | undefined) | undefined;
}

function capture(): Captured & { pi: any } {
  const captured: Captured = {
    tools: new Map(),
    turnStart: undefined,
    beforeAgentStart: undefined,
  };
  const pi = {
    on: (event: string, handler: any) => {
      if (event === "turn_start") captured.turnStart = handler;
      if (event === "before_agent_start") captured.beforeAgentStart = handler;
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
  it("registers exactly the four task tools", () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    expect([...tools.keys()].sort()).toEqual([
      "task_create",
      "task_get",
      "task_list",
      "task_update",
    ]);
    for (const tool of tools.values()) {
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
      expect(tool.renderShell).toBeUndefined();
    }
  });

  it("registers lifecycle and system-prompt handlers", () => {
    const captured = capture();
    registerExtension(captured.pi);
    expect(typeof captured.turnStart).toBe("function");
    expect(typeof captured.beforeAgentStart).toBe("function");
  });

  it("marks mutation tools for sequential execution", () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    expect(tools.get("task_create").executionMode).toBe("sequential");
    expect(tools.get("task_update").executionMode).toBe("sequential");
    expect(tools.get("task_get").executionMode).toBeUndefined();
    expect(tools.get("task_list").executionMode).toBeUndefined();
  });

  it("exposes summary-only tool descriptions and field contracts on parameter schemas", () => {
    const { tools, pi } = capture();
    registerExtension(pi);

    const create = tools.get("task_create");
    const update = tools.get("task_update");
    const get = tools.get("task_get");
    const list = tools.get("task_list");
    for (const tool of [create, update, get, list]) {
      expect(tool.promptGuidelines).toBeUndefined();
      expect(tool.description.startsWith("Use this tool to")).toBe(true);
      expect(tool.description).not.toContain("## ");
      expect(tool.description).not.toContain("Purpose:");
    }
    expect(create.description).toContain("tracking work state");
    expect(create.description).not.toContain("maxAttempts");
    expect(create.promptSnippet).toBe(
      "Track multi-step work with the task_create/task_update/task_get/task_list tools.",
    );
    expect(create.description).not.toContain("^[a-z][a-z0-9_-]*$");
    expect(update.description).not.toContain("shallow-merge");
    const createItem = create.parameters.properties.tasks.items;
    const updateItem = update.parameters.properties.updates.items;
    expect(updateItem.properties.metadata.description).toContain(
      "shallow-merge",
    );
    expect("assignment" in createItem.properties).toBe(false);
    expect("assignment" in updateItem.properties).toBe(false);
    expect(create.parameters.additionalProperties).toBe(false);
    expect(createItem.additionalProperties).toBe(false);
    expect(updateItem.properties.appendLog.description).toContain(
      "Required for every real status transition",
    );
    expect(createItem.properties.reviewOf.items.minimum).toBe(1);
    expect(createItem.properties.reviewOfRefs.items.pattern).toBe(
      "^[a-z][a-z0-9_-]*$",
    );
    expect(updateItem.properties.reviewOf.description).toContain("Replacement");
    expect(createItem.properties.metadata.description).not.toContain(
      "agentType",
    );
  });

  it("exposes assignment input contracts only when enableAssignment is true", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR as string;
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "pi-tasks.json"),
      JSON.stringify({ enableAssignment: true }),
    );
    const { tools, pi } = capture();
    registerExtension(pi);
    const createItem =
      tools.get("task_create").parameters.properties.tasks.items;
    const updateItem =
      tools.get("task_update").parameters.properties.updates.items;
    expect(createItem.properties.assignment.description).toContain(
      "Planning-only assignment",
    );
    expect(updateItem.properties.assignment.description).toContain(
      "null to remove",
    );
    expect(createItem.additionalProperties).toBe(false);
  });
});

describe("injectGuidelines system-prompt injection", () => {
  async function writeAgentConfig(value: unknown): Promise<void> {
    const agentDir = process.env.PI_CODING_AGENT_DIR as string;
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "pi-tasks.json"),
      JSON.stringify(value),
    );
  }

  it("appends the task-management block by default while task_create is active", () => {
    const captured = capture();
    registerExtension(captured.pi);
    const result = captured.beforeAgentStart?.({
      systemPrompt: "base prompt",
      systemPromptOptions: { selectedTools: ["task_create"] },
    });
    expect(result?.systemPrompt).toContain("base prompt");
    expect(result?.systemPrompt).toContain("<task-management>");
    expect(result?.systemPrompt).toContain("</task-management>");
    // Summary descriptions and promptSnippet stay unchanged by the injection.
    expect(captured.tools.get("task_create").promptSnippet).toBe(
      "Track multi-step work with the task_create/task_update/task_get/task_list tools.",
    );
    expect(
      captured.tools
        .get("task_create")
        .description.startsWith("Use this tool to"),
    ).toBe(true);
  });

  it("keeps duplicate-block protection and selectedTools gating", () => {
    const captured = capture();
    registerExtension(captured.pi);
    expect(
      captured.beforeAgentStart?.({
        systemPrompt: "base <task-management> present",
        systemPromptOptions: { selectedTools: ["task_create"] },
      }),
    ).toBeUndefined();
    expect(
      captured.beforeAgentStart?.({
        systemPrompt: "base prompt",
        systemPromptOptions: { selectedTools: ["task_list"] },
      }),
    ).toBeUndefined();
    expect(
      captured.beforeAgentStart?.({
        systemPrompt: "base prompt",
        systemPromptOptions: {},
      }),
    ).toBeUndefined();
  });

  it("registers no system-prompt handler when injectGuidelines is false", async () => {
    await writeAgentConfig({ injectGuidelines: false });
    const captured = capture();
    registerExtension(captured.pi);
    expect(captured.beforeAgentStart).toBeUndefined();
    // Tools keep their promptSnippet and summary descriptions unchanged.
    expect(captured.tools.get("task_create").promptSnippet).toBe(
      "Track multi-step work with the task_create/task_update/task_get/task_list tools.",
    );
    expect(
      captured.tools
        .get("task_create")
        .description.startsWith("Use this tool to"),
    ).toBe(true);
    expect([...captured.tools.keys()].sort()).toEqual([
      "task_create",
      "task_get",
      "task_list",
      "task_update",
    ]);
  });
});

describe("tool behavior", () => {
  it("creates reviewOfRefs and replaces reviewOf through tool contracts", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx("tool-reviews");
    const created = await tools.get("task_create").execute(
      "reviews-create",
      {
        tasks: [
          {
            ref: "review",
            subject: "Review",
            description: "",
            reviewOfRefs: ["writer"],
          },
          { ref: "writer", subject: "Write", description: "" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(
      JSON.parse(created.content[0].text).tasks.map(
        (task: { id: number; reviewOf: number[] }) => [task.id, task.reviewOf],
      ),
    ).toEqual([
      [1, []],
      [2, [1]],
    ]);

    const updated = await tools
      .get("task_update")
      .execute(
        "reviews-update",
        { updates: [{ id: 2, reviewOf: [] }] },
        undefined,
        undefined,
        ctx,
      );
    expect(JSON.parse(updated.content[0].text).updated[0].reviewOf).toEqual([]);
  });

  it("renders filtered completed rows with full reverse-review context", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx("filtered-review-glyph");
    await tools.get("task_create").execute(
      "filtered-create",
      {
        tasks: [
          { ref: "writer", subject: "Write", description: "" },
          {
            ref: "review",
            subject: "Review",
            description: "",
            reviewOfRefs: ["writer"],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    await tools
      .get("task_update")
      .execute(
        "filtered-start",
        { updates: [{ id: 1, status: "in_progress", appendLog: "start" }] },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("task_update")
      .execute(
        "filtered-complete",
        { updates: [{ id: 1, status: "completed", appendLog: "done" }] },
        undefined,
        undefined,
        ctx,
      );

    const listed = await tools
      .get("task_list")
      .execute(
        "filtered-list",
        { status: "completed" },
        undefined,
        undefined,
        ctx,
      );
    expect(
      JSON.parse(listed.content[0].text).map((task: { id: number }) => task.id),
    ).toEqual([1]);
    expect(listed.details.rendering.expanded).toContain(
      "○ #1 Write → completed",
    );
  });

  it("preserves widget insertion order while mounted task data changes", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const cwd = await mkdtemp(join(tmpdir(), "pi-task-widget-order-"));
    dirs.push(cwd);
    const widgets = new Map<string, any>();
    const tui = { terminal: { columns: 80 }, requestRender: () => {} };
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      strikethrough: (text: string) => text,
    };
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "widget-order" },
      ui: {
        setWidget: (key: string, content: unknown) => {
          widgets.get(key)?.dispose?.();
          widgets.delete(key);
          if (content === undefined) return;
          widgets.set(
            key,
            typeof content === "function" ? content(tui, theme) : content,
          );
        },
      },
    };

    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "before", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    ctx.ui.setWidget("agents", ["agent"]);
    expect([...widgets.keys()]).toEqual(["tasks", "agents"]);

    await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 1, subject: "after" }] },
        undefined,
        undefined,
        ctx,
      );
    expect([...widgets.keys()]).toEqual(["tasks", "agents"]);
    expect(widgets.get("tasks").render().join("\n")).toContain("after");

    await tools
      .get("task_update")
      .execute(
        "c3",
        { updates: [{ id: 1, status: "deleted", appendLog: "note" }] },
        undefined,
        undefined,
        ctx,
      );
  });

  it("creates, gets, lists, updates, and soft-deletes through the tools", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx, widgets } = await freshCtx();
    const progress: unknown[] = [];
    const onUpdate = (update: unknown) => progress.push(update);

    const created = await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "Work", description: "do things" }] },
        undefined,
        onUpdate,
        ctx,
      );
    expect(created.isError).toBeUndefined();
    expect(widgets).toHaveLength(1);
    expect(JSON.parse(created.content[0].text).tasks[0]).toMatchObject({
      id: 1,
      subject: "Work",
      status: "pending",
    });
    expect(created.content[0].text).not.toContain("Created task");
    expect(created.details.rendering).toEqual({
      collapsed: "✓ Created 1 task",
      expanded: "✓ Created 1 task\n  ◌ #1 Work",
    });

    const listed = await tools
      .get("task_list")
      .execute("c2", {}, undefined, onUpdate, ctx);
    expect(JSON.parse(listed.content[0].text)).toHaveLength(1);
    expect(listed.details.rendering.collapsed).toBe("✓ Listed 1 task");

    const gotten = await tools
      .get("task_get")
      .execute("c3", { id: 1 }, undefined, onUpdate, ctx);
    expect(JSON.parse(gotten.content[0].text).subject).toBe("Work");
    expect(gotten.details.rendering.collapsed).toBe("✓ Retrieved task #1");

    await tools
      .get("task_update")
      .execute(
        "c3b",
        { updates: [{ id: 1, status: "in_progress", appendLog: "start" }] },
        undefined,
        onUpdate,
        ctx,
      );
    const updated = await tools
      .get("task_update")
      .execute(
        "c4",
        { updates: [{ id: 1, status: "completed", appendLog: "done" }] },
        undefined,
        onUpdate,
        ctx,
      );
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text).updated[0]).toMatchObject({
      id: 1,
      status: "completed",
    });
    expect(updated.content[0].text).not.toContain("Updated task");
    expect(updated.details.rendering).toEqual({
      collapsed: "✓ Updated 1 task",
      expanded: "✓ Updated 1 task\n  ● #1 Work → status, log",
    });
    expect(JSON.stringify(updated.details)).not.toContain("createdAt");
    expect(widgets).toHaveLength(1);

    const filtered = await tools
      .get("task_list")
      .execute("c5", { status: "completed" }, undefined, undefined, ctx);
    expect(JSON.parse(filtered.content[0].text)).toHaveLength(1);

    await tools
      .get("task_update")
      .execute(
        "c5b",
        { updates: [{ id: 1, status: "in_progress", appendLog: "rework" }] },
        undefined,
        onUpdate,
        ctx,
      );
    await tools
      .get("task_update")
      .execute(
        "c5c",
        { updates: [{ id: 1, status: "paused", appendLog: "pause" }] },
        undefined,
        onUpdate,
        ctx,
      );
    const deleted = await tools.get("task_update").execute(
      "c6",
      {
        updates: [
          { id: 1, status: "deleted", appendLog: "removed from scope" },
        ],
      },
      undefined,
      onUpdate,
      ctx,
    );
    expect(deleted.isError).toBeUndefined();
    expect(JSON.parse(deleted.content[0].text).updated[0]).toMatchObject({
      id: 1,
      status: "deleted",
    });
    expect(deleted.details.rendering).toEqual({
      collapsed: "✓ Updated 1 task",
      expanded: "✓ Updated 1 task\n  ⌫ #1 Work → status, log",
    });
    const deletedList = await tools
      .get("task_list")
      .execute("c7", { status: "deleted" }, undefined, undefined, ctx);
    expect(JSON.parse(deletedList.content[0].text)).toHaveLength(1);
    expect(widgets).toHaveLength(1);
    expect(progress).toEqual([]);
  });

  it("returns clear error results for invalid and not-found operations", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();

    const missing = await tools
      .get("task_get")
      .execute("c1", { id: 5 }, undefined, undefined, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("does not exist");

    const invalid = await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 0, status: "deleted", appendLog: "note" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("positive safe integer");

    const badDep = await tools
      .get("task_create")
      .execute(
        "c3",
        { tasks: [{ subject: "x", description: "", blockedBy: [9] }] },
        undefined,
        undefined,
        ctx,
      );
    expect(badDep.isError).toBe(true);

    const gated = await tools
      .get("task_create")
      .execute(
        "c4",
        { tasks: [{ subject: "dep", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(gated.isError).toBeUndefined();
    const blocked = await tools
      .get("task_create")
      .execute(
        "c5",
        { tasks: [{ subject: "main", description: "", blockedBy: [1] }] },
        undefined,
        undefined,
        ctx,
      );
    expect(blocked.isError).toBeUndefined();
    const early = await tools
      .get("task_update")
      .execute(
        "c6",
        { updates: [{ id: 2, status: "in_progress", appendLog: "note" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain("not completed");
  });

  it("requires description, omits color, and constrains every ID schema to safe integers", () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const create = tools.get("task_create").parameters as any;
    const update = tools.get("task_update").parameters as any;
    const createItem = create.properties.tasks.items;
    const updateItem = update.properties.updates.items;
    expect(create.required).toContain("tasks");
    expect(create.properties.tasks.minItems).toBe(1);
    expect(update.required).toContain("updates");
    expect(update.properties.updates.minItems).toBe(1);
    expect(createItem.required).toContain("description");
    expect("color" in createItem.properties).toBe(false);
    expect("color" in updateItem.properties).toBe(false);
    expect(createItem.properties.blockedBy.items.maximum).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(createItem.properties.ref.pattern).toBe("^[a-z][a-z0-9_-]*$");
    expect(updateItem.properties.id.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(updateItem.properties.blockedBy.items.maximum).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(tools.get("task_get").parameters.properties.id.maximum).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(
      updateItem.properties.status.anyOf.map(
        (entry: { const: string }) => entry.const,
      ),
    ).toContain("deleted");
  });

  it("rejects unsafe integer IDs at runtime", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    const result = await tools
      .get("task_get")
      .execute(
        "c1",
        { id: Number.MAX_SAFE_INTEGER + 1 },
        undefined,
        undefined,
        ctx,
      );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("positive safe integer");
  });

  it("returns full created and post-update task payloads", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();

    const created = await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "Work", description: "do things" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(created.isError).toBeUndefined();
    const createdTask = JSON.parse(created.content[0].text).tasks[0];
    expect(createdTask).toMatchObject({
      id: 1,
      subject: "Work",
      description: "do things",
      status: "pending",
    });

    const updated = await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 1, subject: "Renamed" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text).updated[0]).toMatchObject({
      id: 1,
      subject: "Renamed",
      description: "do things",
    });

    const gotten = await tools
      .get("task_get")
      .execute("c3", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text)).toMatchObject({
      id: 1,
      subject: "Renamed",
      description: "do things",
    });
  });

  it("returns actual post-update tasks and removes nullable fields", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();

    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "Work", description: "original" }] },
        undefined,
        undefined,
        ctx,
      );
    const updated = await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 1, subject: "Renamed", assignment: null }] },
        undefined,
        undefined,
        ctx,
      );
    expect(updated.isError).toBeUndefined();
    const postUpdate = JSON.parse(updated.content[0].text).updated[0];
    expect(postUpdate).toMatchObject({
      id: 1,
      subject: "Renamed",
      description: "original",
    });
    expect("assignment" in postUpdate).toBe(false);
    expect("color" in postUpdate).toBe(false);
  });

  it("rejects color supplied to task_create and task_update", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();

    const create = await tools.get("task_create").execute(
      "c1",
      {
        tasks: [{ subject: "Labeled", description: "details", color: "red" }],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(create.isError).toBe(true);
    expect(create.content[0].text).toContain("`color` is no longer supported");

    await tools
      .get("task_create")
      .execute(
        "c2",
        { tasks: [{ subject: "Labeled", description: "details" }] },
        undefined,
        undefined,
        ctx,
      );
    const update = await tools
      .get("task_update")
      .execute(
        "c3",
        { updates: [{ id: 1, color: null }] },
        undefined,
        undefined,
        ctx,
      );
    expect(update.isError).toBe(true);
    expect(update.content[0].text).toContain("`color` is no longer supported");
  });

  it("clears an all-completed cycle on turn_start and preserves the next task ID", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const { tools } = captured;
    const { cwd, ctx, widgets } = await freshCtx();
    const path = taskFilePath(cwd, "tools-session");

    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "a", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("task_update")
      .execute(
        "c1b",
        { updates: [{ id: 1, status: "in_progress", appendLog: "start" }] },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 1, status: "completed", appendLog: "done" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(existsSync(path)).toBe(true);

    await captured.turnStart?.({ type: "turn_start" }, ctx);
    expect(existsSync(path)).toBe(true);
    expect(widgets.at(-1)).toEqual({ key: "tasks", content: undefined });

    const listed = await tools
      .get("task_list")
      .execute("c3", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      nextId: 2,
      history: [{ tasks: [{ id: 1, subject: "a", status: "completed" }] }],
    });

    const recreated = await tools
      .get("task_create")
      .execute(
        "c4",
        { tasks: [{ subject: "b", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(recreated.isError).toBeUndefined();
    expect(JSON.parse(recreated.content[0].text).tasks[0]).toMatchObject({
      id: 2,
      subject: "b",
    });
  });

  it("preserves the completed file and widget when a reset task_create fails validation", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const { tools } = captured;
    const { cwd, ctx, widgets } = await freshCtx();
    const path = taskFilePath(cwd, "tools-session");

    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "a", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("task_update")
      .execute(
        "c1b",
        { updates: [{ id: 1, status: "in_progress", appendLog: "start" }] },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 1, status: "completed", appendLog: "done" }] },
        undefined,
        undefined,
        ctx,
      );
    const beforeDisk = await readFile(path, "utf8");
    const widgetCount = widgets.length;

    const badSubject = await tools
      .get("task_create")
      .execute(
        "c3",
        { tasks: [{ subject: "  ", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(badSubject.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
    expect(widgets.length).toBe(widgetCount);

    const staleDep = await tools
      .get("task_create")
      .execute(
        "c4",
        { tasks: [{ subject: "b", description: "", blockedBy: [1] }] },
        undefined,
        undefined,
        ctx,
      );
    expect(staleDep.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe(beforeDisk);
    expect(widgets.length).toBe(widgetCount);

    const listed = await tools
      .get("task_list")
      .execute("c5", {}, undefined, undefined, ctx);
    expect(
      JSON.parse(listed.content[0].text).map(
        (task: { subject: string }) => task.subject,
      ),
    ).toEqual(["a"]);

    const recreated = await tools
      .get("task_create")
      .execute(
        "c6",
        { tasks: [{ subject: "b", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(recreated.isError).toBeUndefined();
    expect(JSON.parse(recreated.content[0].text).tasks[0]).toMatchObject({
      id: 2,
      subject: "b",
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      history: [{ tasks: [{ id: 1, subject: "a", status: "completed" }] }],
    });
  });

  it("appends with the existing nextId when any task is still active", async () => {
    const captured = capture();
    registerExtension(captured.pi);
    const { tools } = captured;
    const { ctx } = await freshCtx();

    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "a", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("task_create")
      .execute(
        "c2",
        { tasks: [{ subject: "b", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("task_update")
      .execute(
        "c3",
        { updates: [{ id: 1, status: "completed", appendLog: "note" }] },
        undefined,
        undefined,
        ctx,
      );
    await captured.turnStart?.({ type: "turn_start" }, ctx);

    const recreated = await tools
      .get("task_create")
      .execute(
        "c4",
        { tasks: [{ subject: "c", description: "" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(recreated.isError).toBeUndefined();
    expect(JSON.parse(recreated.content[0].text).tasks[0]).toMatchObject({
      id: 3,
      subject: "c",
    });

    const listed = await tools
      .get("task_list")
      .execute("c5", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)).toHaveLength(3);
  });
});

describe("attempt limits via tools", () => {
  async function writeAgentConfig(value: unknown): Promise<void> {
    const agentDir = process.env.PI_CODING_AGENT_DIR as string;
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "pi-tasks.json"),
      JSON.stringify(value),
    );
  }

  it("creates with attempt 0 and default maxAttempts 8, and surfaces them in every payload", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    const created = await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "W", description: "d" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(created.isError).toBeUndefined();
    const createdTask = JSON.parse(created.content[0].text).tasks[0];
    expect(createdTask).toMatchObject({ attempt: 0, maxAttempts: 8 });

    const gotten = await tools
      .get("task_get")
      .execute("c2", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text)).toMatchObject({
      attempt: 0,
      maxAttempts: 8,
    });

    const listed = await tools
      .get("task_list")
      .execute("c3", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)[0]).toMatchObject({
      attempt: 0,
      maxAttempts: 8,
    });
  });

  it("applies the configured maxAttempts to tool-created tasks", async () => {
    await writeAgentConfig({ maxAttempts: 3 });
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    const created = await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "W", description: "d" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(created.isError).toBeUndefined();
    expect(JSON.parse(created.content[0].text).tasks[0]).toMatchObject({
      attempt: 0,
      maxAttempts: 3,
    });
  });

  it("excludes maxAttempts from the task_create schema and rejects supplied input", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const create = tools.get("task_create").parameters as any;
    expect("maxAttempts" in create.properties.tasks.items.properties).toBe(
      false,
    );
    expect(create.additionalProperties).toBe(false);
    expect(create.properties.tasks.items.additionalProperties).toBe(false);
    const { ctx } = await freshCtx();
    for (const maxAttempts of [2, 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      const bad = await tools
        .get("task_create")
        .execute(
          "bad",
          { tasks: [{ subject: "W", description: "d", maxAttempts }] },
          undefined,
          undefined,
          ctx,
        );
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/maxAttempts/);
    }
    for (const maxAttempts of [2, 0]) {
      const bad = await tools
        .get("task_create")
        .execute(
          "bad-top",
          { tasks: [{ subject: "W", description: "d" }], maxAttempts },
          undefined,
          undefined,
          ctx,
        );
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/maxAttempts/);
    }
    const listed = await tools
      .get("task_list")
      .execute("c2", {}, undefined, undefined, ctx);
    expect(JSON.parse(listed.content[0].text)).toEqual([]);
  });

  it("excludes attempt and maxAttempts from the task_update schema and rejects them at runtime", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const update = tools.get("task_update").parameters as any;
    const updateItem = update.properties.updates.items;
    expect("attempt" in updateItem.properties).toBe(false);
    expect("maxAttempts" in updateItem.properties).toBe(false);
    const { ctx } = await freshCtx();
    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "W", description: "d" }] },
        undefined,
        undefined,
        ctx,
      );
    for (const patch of [
      { id: 1, attempt: 1 },
      { id: 1, maxAttempts: 1 },
    ]) {
      const result = await tools
        .get("task_update")
        .execute("c2", { updates: [patch] }, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/[Aa]ttempt/);
    }
    const gotten = await tools
      .get("task_get")
      .execute("c3", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text)).toMatchObject({
      attempt: 0,
      maxAttempts: 8,
    });
  });

  it("exposes appendLog and preserves description while appending a timestamped note", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const update = tools.get("task_update");
    const schema = update.parameters as any;
    const updateItem = schema.properties.updates.items;
    expect(updateItem.properties.appendLog).toBeDefined();
    expect(updateItem.properties.description.description).toContain(
      "use `appendLog` instead",
    );
    expect(updateItem.properties.appendLog.description).toContain(
      "Execution note appended with a timestamp",
    );
    expect(update.description.startsWith("Use this tool to")).toBe(true);

    const { ctx } = await freshCtx();
    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "Work", description: "original" }] },
        undefined,
        undefined,
        ctx,
      );
    const result = await update.execute(
      "c2",
      { updates: [{ id: 1, appendLog: "Needs another pass" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(
      JSON.parse(result.content[0].text).updated[0].log.at(-1).message,
    ).toBe("Needs another pass");
    const stored = JSON.parse(
      (
        await tools
          .get("task_get")
          .execute("c3", { id: 1 }, undefined, undefined, ctx)
      ).content[0].text,
    );
    expect(stored.description).toBe("original");
    expect(stored.log).toHaveLength(1);
    expect(stored.log[0].timestamp).toMatch(/Z$/);
    expect(stored.log[0].message).toBe("Needs another pass");
  });

  it("returns the updated task and increments attempt immediately on entry", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "Work", description: "d" }] },
        undefined,
        undefined,
        ctx,
      );
    const updated = await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.content[0].text).updated[0]).toMatchObject({
      id: 1,
      status: "in_progress",
      attempt: 1,
    });
    const stored = JSON.parse(
      (
        await tools
          .get("task_get")
          .execute("c3", { id: 1 }, undefined, undefined, ctx)
      ).content[0].text,
    );
    expect(stored).toMatchObject({
      attempt: 1,
      maxAttempts: 8,
      status: "in_progress",
    });
  });

  it("rejects exhausted entry with the exact message and preserves persisted state", async () => {
    await writeAgentConfig({ maxAttempts: 1 });
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "Work", description: "d" }] },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 1, status: "in_progress", appendLog: "note" }] },
        undefined,
        undefined,
        ctx,
      );
    await tools
      .get("task_update")
      .execute(
        "c3",
        { updates: [{ id: 1, status: "completed", appendLog: "note" }] },
        undefined,
        undefined,
        ctx,
      );
    const before = await tools
      .get("task_get")
      .execute("c4", { id: 1 }, undefined, undefined, ctx);
    const rejected = await tools.get("task_update").execute(
      "c5",
      {
        updates: [
          {
            id: 1,
            status: "in_progress",
            subject: "leaked",
            appendLog: "note",
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toBe(
      "Task #1 has reached the maximum number of attempts (1).",
    );
    const after = await tools
      .get("task_get")
      .execute("c6", { id: 1 }, undefined, undefined, ctx);
    expect(after.content[0].text).toBe(before.content[0].text);
  });
});

describe("renamed prefix guard via tools", () => {
  it("rejects stale prefix on task_create", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    const result = await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "W", description: "d", prefix: "api" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("`prefix` is no longer supported.");
  });

  it("rejects stale prefix on task_update", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx();
    await tools
      .get("task_create")
      .execute(
        "c1",
        { tasks: [{ subject: "W", description: "d" }] },
        undefined,
        undefined,
        ctx,
      );
    const result = await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 1, prefix: "api" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("`prefix` is no longer supported.");
  });
});

describe("batch tool integration", () => {
  it("creates a dependency batch and returns ref mappings plus all tasks", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx("batch-create-tools");
    const result = await tools.get("task_create").execute(
      "batch-create",
      {
        tasks: [
          {
            ref: "review",
            subject: "Review",
            description: "",
            blockedByRefs: ["implement"],
          },
          {
            ref: "implement",
            subject: "Implement",
            description: "",
            blockedByRefs: ["inspect"],
          },
          { ref: "inspect", subject: "Inspect", description: "" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.created).toEqual([
      { ref: "inspect", id: 1 },
      { ref: "implement", id: 2 },
      { ref: "review", id: 3 },
    ]);
    expect(
      payload.tasks.map((task: any) => [task.id, task.subject, task.blockedBy]),
    ).toEqual([
      [1, "Inspect", []],
      [2, "Implement", [1]],
      [3, "Review", [2]],
    ]);
    expect(JSON.stringify(payload.tasks)).not.toContain('"ref"');
  });

  it("updates dependencies declaratively and returns actual post-update tasks", async () => {
    const { tools, pi } = capture();
    registerExtension(pi);
    const { ctx } = await freshCtx("batch-update-tools");
    await tools.get("task_create").execute(
      "create",
      {
        tasks: [
          { ref: "dependency", subject: "Dependency", description: "" },
          {
            ref: "dependent",
            subject: "Dependent",
            description: "",
            blockedByRefs: ["dependency"],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    await tools
      .get("task_update")
      .execute(
        "start-dep",
        { updates: [{ id: 1, status: "in_progress", appendLog: "start" }] },
        undefined,
        undefined,
        ctx,
      );
    const result = await tools.get("task_update").execute(
      "update",
      {
        updates: [
          { id: 2, status: "in_progress", appendLog: "note" },
          { id: 1, status: "completed", appendLog: "done" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(
      JSON.parse(result.content[0].text).updated.map((task: any) => [
        task.id,
        task.status,
        task.attempt,
      ]),
    ).toEqual([
      [1, "completed", 1],
      [2, "in_progress", 1],
    ]);
  });
});
