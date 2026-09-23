import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type PiTasksConfig } from "../src/config.js";
import registerExtension from "../src/index.js";
import { TaskStore, taskFilePath } from "../src/store.js";
import { buildTaskDetailLines, createTasksViewer } from "../src/tasks-ui.js";
import { renderTaskGet, renderTaskUpdate, semanticDiff } from "../src/tool-rendering.js";
import type { Task } from "../src/types.js";
import {
  assigneeColumnWidth,
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
  const agentDir = await mkdtemp(join(tmpdir(), "pi-task-assignee-agent-"));
  dirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  if (hadAgentDir) process.env.PI_CODING_AGENT_DIR = savedAgentDir as string;
  else delete process.env.PI_CODING_AGENT_DIR;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeAgentConfig(value: unknown): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR as string;
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "pi-tasks.json"), JSON.stringify(value));
}

function capture() {
  const tools = new Map<string, any>();
  let beforeAgentStart: ((event: any) => { systemPrompt: string } | undefined) | undefined;
  const pi = {
    on: (event: string, handler: any) => {
      if (event === "before_agent_start") beforeAgentStart = handler;
    },
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (_name: string, _command: unknown) => {},
  };
  registerExtension(pi as any);
  return { tools, beforeAgentStart: beforeAgentStart as NonNullable<typeof beforeAgentStart> };
}

async function freshCtx(sessionId = "assignee-session") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-task-assignee-"));
  dirs.push(cwd);
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: { setWidget: () => {} },
  };
  return { ctx };
}

function task(overrides: Partial<Task> & { id: number; subject: string }): Task {
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
const enabledConfig: PiTasksConfig = { ...DEFAULT_CONFIG, enableAssignee: true };

async function promptFor(config: unknown): Promise<string | undefined> {
  await writeAgentConfig(config);
  const { beforeAgentStart } = capture();
  return beforeAgentStart({
    systemPrompt: "base prompt",
    systemPromptOptions: { selectedTools: ["task_create"] },
  })?.systemPrompt;
}

describe("enableAssignee tool schemas", () => {
  it("omits assignee from create/update schemas by default with additionalProperties false", () => {
    const { tools } = capture();
    const createItem = tools.get("task_create").parameters.properties.tasks.items;
    const updateItem = tools.get("task_update").parameters.properties.updates.items;
    expect("assignee" in createItem.properties).toBe(false);
    expect("assignee" in updateItem.properties).toBe(false);
    expect(tools.get("task_create").parameters.additionalProperties).toBe(false);
    expect(createItem.additionalProperties).toBe(false);
    expect(updateItem.additionalProperties).toBe(false);
  });

  it("exposes create assignee?: string and update assignee?: string|null when enabled", async () => {
    await writeAgentConfig({ enableAssignee: true });
    const { tools } = capture();
    const createItem = tools.get("task_create").parameters.properties.tasks.items;
    const updateItem = tools.get("task_update").parameters.properties.updates.items;
    expect(createItem.properties.assignee.description).toContain("Assigned owner or agent");
    expect(updateItem.properties.assignee.description).toContain("null to remove");
    expect(createItem.additionalProperties).toBe(false);
    expect(updateItem.additionalProperties).toBe(false);
    expect(tools.get("task_create").parameters.additionalProperties).toBe(false);
  });

  it("round-trips assignee input through enabled tools while the store keeps working either way", async () => {
    await writeAgentConfig({ enableAssignee: true });
    const { tools } = capture();
    const { ctx } = await freshCtx("assignee-roundtrip");
    const created = await tools.get("task_create").execute(
      "c1",
      { tasks: [{ subject: "Work", description: "", assignee: "api" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(created.isError).toBeUndefined();
    expect(JSON.parse(created.content[0].text).tasks[0]).toMatchObject({ assignee: "api" });
    const updated = await tools.get("task_update").execute(
      "c2",
      { updates: [{ id: 1, assignee: null }] },
      undefined,
      undefined,
      ctx,
    );
    expect(updated.isError).toBeUndefined();
    expect("assignee" in JSON.parse(updated.content[0].text).updated[0]).toBe(false);
  });
});

describe("enableAssignee system prompt", () => {
  it("contains no owner/assignee guidance by default", async () => {
    const prompt = await promptFor({});
    expect(prompt).toContain("<task-management>");
    expect(prompt).not.toContain("assignee");
    expect(prompt).not.toContain("owners");
    expect(prompt).not.toContain("ownership");
    expect(prompt).not.toContain("Assignment");
    expect(prompt).toContain("acceptance checks");
  });

  it("adds owners wording and a concise Assignment section when enabled", async () => {
    const prompt = await promptFor({ enableAssignee: true });
    expect(prompt).toContain("<task-management>");
    expect(prompt).toContain("owners");
    expect(prompt).toContain("## Assignment");
    expect(prompt).toContain("only when the intended owner or agent type is known");
    expect(prompt).toContain("records ownership only and does not dispatch, start, or authorize execution");
    expect(prompt).toContain("Do not invent an assignee");
    expect(prompt).toContain("`assignee: null` to remove an existing assignment");
  });

  it("keeps duplicate-block protection and selectedTools gating in both modes", async () => {
    for (const config of [{}, { enableAssignee: true }]) {
      await writeAgentConfig(config);
      const { beforeAgentStart } = capture();
      expect(
        beforeAgentStart({
          systemPrompt: "base <task-management> present",
          systemPromptOptions: { selectedTools: ["task_create"] },
        }),
      ).toBeUndefined();
      expect(
        beforeAgentStart({
          systemPrompt: "base prompt",
          systemPromptOptions: { selectedTools: ["task_list"] },
        }),
      ).toBeUndefined();
    }
  });
});

describe("enableAssignee widget rendering", () => {
  const assigned = () => [
    task({ id: 1, subject: "Pending subject", assignee: "api" }),
    task({ id: 2, subject: "Active subject", assignee: "long-agent", status: "in_progress" }),
  ];

  it("hides assignee and reserves no assignee column by default", () => {
    expect(assigneeColumnWidth(assigned())).toBe(0);
    expect(formatTaskLine(assigned()[0], FIXED_NOW)).toBe("  ◌ #1 ↻9 Pending subject");
    const lines = buildWidgetLines(assigned(), FIXED_NOW);
    expect(lines.slice(1)).toEqual([
      "  ◌ #1 ↻9 Pending subject",
      "  ◌ #2 ↻9 Active subject 1d 1h 1m 1s",
    ]);
    expect(lines.join("\n")).not.toContain("@");
    const themed = renderWidgetLines(assigned(), fakeTheme, undefined, true, FIXED_NOW);
    expect(themed.join("\n")).not.toContain("@api");
    expect(themed.join("\n")).not.toContain("@long-agent");
  });

  it("hides assignee even when an explicit assignee width is passed", () => {
    expect(
      formatTaskLine(assigned()[0], FIXED_NOW, DEFAULT_CONFIG, undefined, undefined, "@long-agent".length),
    ).toBe("  ◌ #1 ↻9 Pending subject");
  });

  it("preserves assignee display and alignment when enabled", () => {
    expect(assigneeColumnWidth(assigned(), enabledConfig)).toBe("@long-agent".length);
    const lines = buildWidgetLines(assigned(), FIXED_NOW, undefined, enabledConfig);
    expect(lines[1]).toContain("@api");
    expect(lines[2]).toContain("@long-agent");
    expect(lines[1].indexOf("Pending subject")).toBe(lines[2].indexOf("Active subject"));
    const themed = renderWidgetLines(assigned(), fakeTheme, undefined, true, FIXED_NOW, undefined, enabledConfig);
    expect(themed[1]).toContain("<text>@api       </>");
    expect(themed[2]).toContain("<text>*@long-agent*</>");
  });
});

describe("enableAssignee viewer and tool rendering", () => {
  it("omits the Assignee detail row by default and shows it when enabled", () => {
    const detail = buildTaskDetailLines(task({ id: 1, subject: "a", assignee: "api" }));
    expect(detail.join("\n")).not.toContain("Assignee");
    expect(detail.join("\n")).not.toContain("@api");
    const enabled = buildTaskDetailLines(task({ id: 1, subject: "a", assignee: "api" }), enabledConfig);
    expect(enabled).toContain("Assignee: @api");
    expect(buildTaskDetailLines(task({ id: 1, subject: "a" }), enabledConfig)).toContain("Assignee: (none)");
  });

  it("hides assignee in the viewer overlay by default and shows it when enabled", () => {
    const done = () => {};
    const tasks = [task({ id: 1, subject: "a", assignee: "api" })];
    const hidden = createTasksViewer(tasks, { done }).render(80).join("\n");
    expect(hidden).not.toContain("@api");
    expect(hidden).not.toContain("Assignee");
    const shown = createTasksViewer(tasks, { done, config: enabledConfig }).render(80).join("\n");
    expect(shown).toContain("Assignee: @api");
  });

  it("hides assignee in get rendering and update diffs by default", () => {
    const before = task({ id: 1, subject: "Work", assignee: "old" });
    const after = task({ id: 1, subject: "Changed", assignee: "new" });
    expect(semanticDiff(before, after)).toContain("assignee");
    const view = renderTaskGet(after);
    expect(view.expanded).not.toContain("Assignee");
    expect(view.expanded).not.toContain("new");
    const update = renderTaskUpdate([{ before, after }]);
    expect(update.expanded).toContain("subject");
    expect(update.expanded).not.toContain("assignee");
    const enabledView = renderTaskGet(after, [after], enabledConfig);
    expect(enabledView.expanded).toContain("Assignee: new");
    const enabledUpdate = renderTaskUpdate([{ before, after }], enabledConfig);
    expect(enabledUpdate.expanded).toContain("assignee");
  });
});

describe("enableAssignee persisted-data compatibility", () => {
  it("keeps raw assignee payloads intact while disabled and re-shows them when enabled", async () => {
    await writeAgentConfig({ enableAssignee: true });
    const enabled = capture();
    const { ctx } = await freshCtx("assignee-compat");
    const created = await enabled.tools.get("task_create").execute(
      "c1",
      { tasks: [{ subject: "Work", description: "", assignee: "api" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(JSON.parse(created.content[0].text).tasks[0]).toMatchObject({ assignee: "api" });

    await writeAgentConfig({ enableAssignee: false });
    const disabled = capture();
    const gotten = await disabled.tools.get("task_get").execute("c2", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(gotten.content[0].text)).toMatchObject({ assignee: "api" });
    const store = await TaskStore.load(taskFilePath(ctx.cwd, "assignee-compat"));
    expect(store.get(1)).toMatchObject({ assignee: "api" });
    expect(gotten.details.rendering.expanded).not.toContain("@api");

    await writeAgentConfig({ enableAssignee: true });
    const reenabled = capture();
    const regotten = await reenabled.tools.get("task_get").execute("c3", { id: 1 }, undefined, undefined, ctx);
    expect(JSON.parse(regotten.content[0].text)).toMatchObject({ assignee: "api" });
    expect(regotten.details.rendering.expanded).toContain("Assignee: api");
  });

  it("does not rewrite the store file solely due to config", async () => {
    await writeAgentConfig({ enableAssignee: true });
    const enabled = capture();
    const { ctx } = await freshCtx("assignee-no-rewrite");
    await enabled.tools.get("task_create").execute(
      "c1",
      { tasks: [{ subject: "Work", description: "", assignee: "api" }] },
      undefined,
      undefined,
      ctx,
    );
    const before = await readFile(taskFilePath(ctx.cwd, "assignee-no-rewrite"), "utf8");
    await writeAgentConfig({});
    const disabled = capture();
    await disabled.tools.get("task_list").execute("c2", {}, undefined, undefined, ctx);
    expect(await readFile(taskFilePath(ctx.cwd, "assignee-no-rewrite"), "utf8")).toBe(before);
    expect(JSON.parse(before).tasks[0]).toMatchObject({ assignee: "api" });
  });
});
