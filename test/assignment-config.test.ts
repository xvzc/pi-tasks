import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type PiTasksConfig } from "../src/config.js";
import registerExtension from "../src/index.js";
import { TaskStore, taskFilePath } from "../src/store.js";
import { buildTaskDetailLines, createTasksViewer } from "../src/tasks-ui.js";
import {
  renderTaskGet,
  renderTaskUpdate,
  semanticDiff,
} from "../src/tool-rendering.js";
import type { Task } from "../src/types.js";
import {
  assignmentColumnWidth,
  buildWidgetLines,
  formatTaskLine,
  renderWidgetLines,
  type ThemeLike,
} from "../src/widget.js";

const dirs: string[] = [];
let savedAgentDir: string | undefined;
let hadAgentDir = false;

beforeEach(async () => {
  hadAgentDir = "PI_CODING_AGENT_DIR" in process.env;
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-task-assignment-agent-"));
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

async function writeAgentConfig(value: unknown): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR as string;
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "pi-tasks.json"),
    JSON.stringify(value),
  );
}

function capture() {
  const tools = new Map<string, any>();
  const events: string[] = [];
  let beforeAgentStart:
    ((event: any) => { systemPrompt: string } | undefined) | undefined;
  const pi = {
    on: (event: string, handler: any) => {
      events.push(event);
      if (event === "before_agent_start") beforeAgentStart = handler;
    },
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (_name: string, _command: unknown) => {},
  };
  registerExtension(pi as any);
  return { tools, events, beforeAgentStart };
}

async function freshCtx(sessionId = "assignment-session") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-task-assignment-"));
  dirs.push(cwd);
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: { setWidget: () => {} },
  };
  return { ctx };
}

function task(
  overrides: Partial<Task> & { id: number; subject: string },
): Task {
  return {
    description: "",
    status: "pending",
    attempt: 0,
    maxAttempts: 9,
    blockedBy: [],
    reviewOf: [],
    metadata: {},
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const fakeTheme: ThemeLike = {
  fg: (_color: string, text: string) => `<${_color}>${text}</>`,
  bold: (text: string) => `*${text}*`,
  strikethrough: (text: string) => `~${text}~`,
};

const FIXED_NOW = Date.parse("2026-01-02T01:01:01.000Z");
const enabledConfig: PiTasksConfig = {
  ...DEFAULT_CONFIG,
  enableAssignment: true,
};

async function descriptionsFor(
  config: unknown,
): Promise<Record<string, string>> {
  await writeAgentConfig(config);
  const { tools } = capture();
  return {
    create: tools.get("task_create").description as string,
    update: tools.get("task_update").description as string,
    get: tools.get("task_get").description as string,
    list: tools.get("task_list").description as string,
  };
}

describe("enableAssignment tool schemas", () => {
  it("omits assignment from create/update schemas by default with additionalProperties false", () => {
    const { tools } = capture();
    const createItem =
      tools.get("task_create").parameters.properties.tasks.items;
    const updateItem =
      tools.get("task_update").parameters.properties.updates.items;
    expect("assignment" in createItem.properties).toBe(false);
    expect("assignment" in updateItem.properties).toBe(false);
    expect(tools.get("task_create").parameters.additionalProperties).toBe(
      false,
    );
    expect(createItem.additionalProperties).toBe(false);
    expect(updateItem.additionalProperties).toBe(false);
  });

  it("exposes whole assignment objects and nullable update removal when enabled", async () => {
    await writeAgentConfig({ enableAssignment: true });
    const { tools } = capture();
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
    expect(updateItem.additionalProperties).toBe(false);
    expect(tools.get("task_create").parameters.additionalProperties).toBe(
      false,
    );
  });

  it("round-trips assignment input through enabled tools while the store keeps working either way", async () => {
    await writeAgentConfig({ enableAssignment: true });
    const { tools } = capture();
    const { ctx } = await freshCtx("assignment-roundtrip");
    const created = await tools.get("task_create").execute(
      "c1",
      {
        tasks: [
          {
            subject: "Work",
            description: "",
            assignment: { delegate: true, owner: "api" },
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(created.isError).toBeUndefined();
    expect(JSON.parse(created.content[0].text).tasks[0]).toMatchObject({
      assignment: { delegate: true, owner: "api" },
    });
    const updated = await tools
      .get("task_update")
      .execute(
        "c2",
        { updates: [{ id: 1, assignment: null }] },
        undefined,
        undefined,
        ctx,
      );
    expect(updated.isError).toBeUndefined();
    expect("assignment" in JSON.parse(updated.content[0].text).updated[0]).toBe(
      false,
    );
  });
});

describe("opaque assignment owners", () => {
  async function enabledTools() {
    await writeAgentConfig({ enableAssignment: true });
    return capture().tools;
  }

  it("preserves arbitrary delegated owners and direct assignments", async () => {
    const tools = await enabledTools();
    const { ctx } = await freshCtx("opaque-assignment");
    const result = await tools.get("task_create").execute(
      "c1",
      {
        tasks: [
          {
            subject: "Delegated",
            description: "",
            assignment: { delegate: true, owner: " Custom:Agent " },
          },
          {
            subject: "Direct",
            description: "",
            assignment: { delegate: false, owner: null },
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const tasks = JSON.parse(result.content[0].text).tasks;
    expect(tasks[0].assignment).toEqual({
      delegate: true,
      owner: " Custom:Agent ",
    });
    expect(tasks[1].assignment).toEqual({ delegate: false, owner: null });
  });

  it("rejects invalid assignment structures atomically", async () => {
    const tools = await enabledTools();
    const { ctx } = await freshCtx("invalid-assignment");
    for (const assignment of [
      { delegate: true, owner: "" },
      { delegate: true, owner: "   " },
      { delegate: false, owner: "agent" },
      { delegate: false, owner: null, extra: true },
    ]) {
      const result = await tools
        .get("task_create")
        .execute(
          "bad",
          { tasks: [{ subject: "Bad", description: "", assignment }] },
          undefined,
          undefined,
          ctx,
        );
      expect(result.isError).toBe(true);
    }
    expect(
      (
        await TaskStore.load(taskFilePath(ctx.cwd, "invalid-assignment"))
      ).list(),
    ).toEqual([]);
  });

  it("preserves, replaces, and removes assignments without registry access", async () => {
    const tools = await enabledTools();
    const { ctx } = await freshCtx("assignment-updates");
    await tools.get("task_create").execute(
      "c1",
      {
        tasks: [
          {
            subject: "Work",
            description: "",
            assignment: { delegate: true, owner: "not-installed" },
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    const preserved = await tools
      .get("task_update")
      .execute(
        "u1",
        { updates: [{ id: 1, subject: "Renamed" }] },
        undefined,
        undefined,
        ctx,
      );
    expect(
      JSON.parse(preserved.content[0].text).updated[0].assignment.owner,
    ).toBe("not-installed");
    const replaced = await tools
      .get("task_update")
      .execute(
        "u2",
        { updates: [{ id: 1, assignment: { delegate: false, owner: null } }] },
        undefined,
        undefined,
        ctx,
      );
    expect(JSON.parse(replaced.content[0].text).updated[0].assignment).toEqual({
      delegate: false,
      owner: null,
    });
    const removed = await tools
      .get("task_update")
      .execute(
        "u3",
        { updates: [{ id: 1, assignment: null }] },
        undefined,
        undefined,
        ctx,
      );
    expect(
      JSON.parse(removed.content[0].text).updated[0].assignment,
    ).toBeUndefined();
  });
});

describe("enableAssignment tool descriptions", () => {
  it("contains no owner/assignment guidance by default", async () => {
    const descriptions = await descriptionsFor({});
    for (const description of Object.values(descriptions)) {
      expect(description.toLowerCase()).not.toContain("assignment");
      expect(description.toLowerCase()).not.toContain("owner");
      expect(description.toLowerCase()).not.toContain("ownership");
    }
    expect(descriptions.create).toContain("tracking work state");
  });

  it("carries no ownership guidance in descriptions even when enabled (schema gating only)", async () => {
    const descriptions = await descriptionsFor({ enableAssignment: true });
    for (const description of Object.values(descriptions)) {
      expect(description.toLowerCase()).not.toContain("assignment");
      expect(description.toLowerCase()).not.toContain("owner");
      expect(description.toLowerCase()).not.toContain("ownership");
      expect(description).not.toContain("## ");
    }
    expect(descriptions.get.toLowerCase()).not.toContain("assignment");
    expect(descriptions.list.toLowerCase()).not.toContain("assignment");
  });

  it("exposes no promptGuidelines; before_agent_start follows injectGuidelines", async () => {
    for (const config of [{}, { enableAssignment: true }]) {
      await writeAgentConfig(config);
      const { tools, events, beforeAgentStart } = capture();
      expect(events).toContain("before_agent_start");
      expect(typeof beforeAgentStart).toBe("function");
      expect(tools.get("task_create").promptGuidelines).toBeUndefined();
      expect(tools.get("task_update").promptGuidelines).toBeUndefined();
      expect(tools.get("task_get").promptGuidelines).toBeUndefined();
      expect(tools.get("task_list").promptGuidelines).toBeUndefined();
    }
    await writeAgentConfig({ injectGuidelines: false });
    const disabled = capture();
    expect(disabled.events).not.toContain("before_agent_start");
    expect(disabled.beforeAgentStart).toBeUndefined();
    expect(disabled.tools.get("task_create").promptGuidelines).toBeUndefined();
  });
});

describe("enableAssignment guideline block wording", () => {
  async function guidelinesFor(config: unknown): Promise<string | undefined> {
    await writeAgentConfig(config);
    const { beforeAgentStart } = capture();
    return beforeAgentStart?.({
      systemPrompt: "base prompt",
      systemPromptOptions: { selectedTools: ["task_create"] },
    })?.systemPrompt;
  }

  it("carries no owners/Assignment wording by default", async () => {
    const prompt = await guidelinesFor({});
    expect(prompt).toContain("<task-management>");
    expect(prompt).not.toContain("owners");
    expect(prompt).not.toContain("ownership");
    expect(prompt).not.toContain("## Assignment");
  });

  it("exposes no standalone Assignment section when enabled; semantics live on schema descriptions", async () => {
    const prompt = await guidelinesFor({ enableAssignment: true });
    expect(prompt).toContain("<task-management>");
    expect(prompt).not.toContain("## Assignment");
    await writeAgentConfig({ enableAssignment: true });
    const { tools } = capture();
    const createItem =
      tools.get("task_create").parameters.properties.tasks.items;
    const updateItem =
      tools.get("task_update").parameters.properties.updates.items;
    expect(createItem.properties.assignment.description).toContain(
      "Planning-only assignment",
    );
    expect(createItem.properties.assignment.description).toContain(
      "{ delegate: false, owner: null }",
    );
    expect(createItem.properties.assignment.description).toContain(
      "without runtime discovery",
    );
    expect(createItem.properties.assignment.description).toContain(
      "never dispatches",
    );
    expect(updateItem.properties.assignment.description).toContain(
      "null to remove",
    );
  });

  it("injects nothing when injectGuidelines is false", async () => {
    await writeAgentConfig({ injectGuidelines: false, enableAssignment: true });
    const { beforeAgentStart } = capture();
    expect(beforeAgentStart).toBeUndefined();
  });
});

describe("enableAssignment widget rendering", () => {
  const assigned = () => [
    task({
      id: 1,
      subject: "Pending subject",
      assignment: { delegate: true, owner: "api" },
    }),
    task({
      id: 2,
      subject: "Active subject",
      assignment: { delegate: true, owner: "long-agent" },
      status: "in_progress",
    }),
  ];

  it("hides assignment and reserves no assignment column by default", () => {
    expect(assignmentColumnWidth(assigned())).toBe(0);
    expect(formatTaskLine(assigned()[0], FIXED_NOW)).toBe(
      "  ◌ #1 ↻9 Pending subject",
    );
    const lines = buildWidgetLines(assigned(), FIXED_NOW);
    expect(lines.slice(1)).toEqual([
      "  ◌ #1 ↻9 Pending subject",
      "  ◌ #2 ↻9 Active subject 1d 1h 1m 1s",
    ]);
    expect(lines.join("\n")).not.toContain("@");
    const themed = renderWidgetLines(
      assigned(),
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
    );
    expect(themed.join("\n")).not.toContain("@api");
    expect(themed.join("\n")).not.toContain("@long-agent");
  });

  it("hides assignment even when an explicit assignment width is passed", () => {
    expect(
      formatTaskLine(
        assigned()[0],
        FIXED_NOW,
        DEFAULT_CONFIG,
        undefined,
        undefined,
        "@long-agent".length,
      ),
    ).toBe("  ◌ #1 ↻9 Pending subject");
  });

  it("preserves assignment display and alignment when enabled", () => {
    expect(assignmentColumnWidth(assigned(), enabledConfig)).toBe(
      "@long-agent".length,
    );
    const lines = buildWidgetLines(
      assigned(),
      FIXED_NOW,
      undefined,
      enabledConfig,
    );
    expect(lines[1]).toContain("@api");
    expect(lines[2]).toContain("@long-agent");
    expect(lines[1].indexOf("Pending subject")).toBe(
      lines[2].indexOf("Active subject"),
    );
    const themed = renderWidgetLines(
      assigned(),
      fakeTheme,
      undefined,
      true,
      FIXED_NOW,
      undefined,
      enabledConfig,
    );
    expect(themed[1]).toContain("<text>@api       </>");
    expect(themed[2]).toContain("<text>*@long-agent*</>");
  });
});

describe("enableAssignment viewer and tool rendering", () => {
  it("omits the Assignment detail row by default and shows it when enabled", () => {
    const detail = buildTaskDetailLines(
      task({
        id: 1,
        subject: "a",
        assignment: { delegate: true, owner: "api" },
      }),
    );
    expect(detail.join("\n")).not.toContain("Assignment");
    expect(detail.join("\n")).not.toContain("@api");
    const enabled = buildTaskDetailLines(
      task({
        id: 1,
        subject: "a",
        assignment: { delegate: true, owner: "api" },
      }),
      enabledConfig,
    );
    expect(enabled).toContain("Assignment: @api");
    expect(
      buildTaskDetailLines(task({ id: 1, subject: "a" }), enabledConfig),
    ).toContain("Assignment: (none)");
  });

  it("hides assignment in the viewer overlay by default and shows it when enabled", () => {
    const done = () => {};
    const tasks = [
      task({
        id: 1,
        subject: "a",
        assignment: { delegate: true, owner: "api" },
      }),
    ];
    const hidden = createTasksViewer(tasks, { done }).render(80).join("\n");
    expect(hidden).not.toContain("@api");
    expect(hidden).not.toContain("Assignment");
    const shown = createTasksViewer(tasks, { done, config: enabledConfig })
      .render(80)
      .join("\n");
    expect(shown).toContain("Assignment: @api");
  });

  it("hides assignment in get rendering and update diffs by default", () => {
    const before = task({
      id: 1,
      subject: "Work",
      assignment: { delegate: true, owner: "old" },
    });
    const after = task({
      id: 1,
      subject: "Changed",
      assignment: { delegate: true, owner: "new" },
    });
    expect(semanticDiff(before, after)).toContain("assignment");
    const view = renderTaskGet(after);
    expect(view.expanded).not.toContain("Assignment");
    expect(view.expanded).not.toContain("new");
    const update = renderTaskUpdate([{ before, after }]);
    expect(update.expanded).toContain("subject");
    expect(update.expanded).not.toContain("assignment");
    const enabledView = renderTaskGet(after, [after], enabledConfig);
    expect(enabledView.expanded).toContain("Assignment: @new");
    const enabledUpdate = renderTaskUpdate([{ before, after }], enabledConfig);
    expect(enabledUpdate.expanded).toContain("assignment");
  });
});

describe("enableAssignment persisted data", () => {
  it("keeps raw assignment payloads intact while disabled and re-shows them when enabled", async () => {
    await writeAgentConfig({ enableAssignment: true });
    const enabled = capture();
    const { ctx } = await freshCtx("assignment-compat");
    const created = await enabled.tools.get("task_create").execute(
      "c1",
      {
        tasks: [
          {
            subject: "Work",
            description: "",
            assignment: { delegate: true, owner: "api" },
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(JSON.parse(created.content[0].text).tasks[0]).toMatchObject({
      assignment: { delegate: true, owner: "api" },
    });

    await writeAgentConfig({ enableAssignment: false });
    const disabled = capture();
    const gotten = await disabled.tools
      .get("task_get")
      .execute("c2", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text)).toMatchObject({
      assignment: { delegate: true, owner: "api" },
    });
    const store = await TaskStore.load(
      taskFilePath(ctx.cwd, "assignment-compat"),
    );
    expect(store.get(1)).toMatchObject({
      assignment: { delegate: true, owner: "api" },
    });
    expect(gotten.details.rendering.expanded).not.toContain("@api");

    await writeAgentConfig({ enableAssignment: true });
    const reenabled = capture();
    const regotten = await reenabled.tools
      .get("task_get")
      .execute("c3", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(regotten.content[0].text)).toMatchObject({
      assignment: { delegate: true, owner: "api" },
    });
    expect(regotten.details.rendering.expanded).toContain("Assignment: @api");
  });

  it("does not rewrite the store file solely due to config", async () => {
    await writeAgentConfig({ enableAssignment: true });
    const enabled = capture();
    const { ctx } = await freshCtx("assignment-no-rewrite");
    await enabled.tools.get("task_create").execute(
      "c1",
      {
        tasks: [
          {
            subject: "Work",
            description: "",
            assignment: { delegate: true, owner: "api" },
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    const before = await readFile(
      taskFilePath(ctx.cwd, "assignment-no-rewrite"),
      "utf8",
    );
    await writeAgentConfig({});
    const disabled = capture();
    await disabled.tools
      .get("task_list")
      .execute("c2", {}, undefined, undefined, ctx);
    expect(
      await readFile(taskFilePath(ctx.cwd, "assignment-no-rewrite"), "utf8"),
    ).toBe(before);
    expect(JSON.parse(before).tasks[0]).toMatchObject({
      assignment: { delegate: true, owner: "api" },
    });
  });
});
