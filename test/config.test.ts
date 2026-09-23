import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFilePath, DEFAULT_CONFIG, loadPiTasksConfig } from "../src/config.js";

const dirs: string[] = [];
let savedEnv: string | undefined;
let hadEnv = false;

beforeEach(() => {
  hadEnv = "PI_CODING_AGENT_DIR" in process.env;
  savedEnv = process.env.PI_CODING_AGENT_DIR;
});

afterEach(async () => {
  if (hadEnv) process.env.PI_CODING_AGENT_DIR = savedEnv as string;
  else delete process.env.PI_CODING_AGENT_DIR;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function agentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-tasks-config-"));
  dirs.push(dir);
  return dir;
}

function collector() {
  const messages: string[] = [];
  return { messages, warn: (message: string) => void messages.push(message) };
}

describe("config file path", () => {
  it("resolves extensions/pi-tasks.json under PI_CODING_AGENT_DIR", async () => {
    const dir = await agentDir();
    process.env.PI_CODING_AGENT_DIR = dir;
    expect(configFilePath()).toBe(join(dir, "extensions", "pi-tasks.json"));
  });

  it("accepts an explicit agent dir", () => {
    expect(configFilePath("/tmp/agent")).toBe(join("/tmp/agent", "extensions", "pi-tasks.json"));
  });
});

describe("loadPiTasksConfig", () => {
  it("uses defaults when the file is missing without warning", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(join(dir, "extensions", "pi-tasks.json"), warn)).toEqual(DEFAULT_CONFIG);
    expect(messages).toEqual([]);
  });

  it("returns a fresh copy so callers cannot mutate the defaults", async () => {
    const dir = await agentDir();
    const { warn } = collector();
    const loaded = loadPiTasksConfig(join(dir, "missing.json"), warn);
    loaded.maxAttempts = 0;
    loaded.glyphs.pending.character = "x";
    expect(DEFAULT_CONFIG).toEqual({
      maxAttempts: 8,
      enableAssignee: false,
      glyphs: {
        inProgress: { character: "◌", frames: ["◌", "○", "⨀", "◉", "●", "◉", "⨀", "○", "◌"] },
        pending: { character: "◌", retriedCharacter: "■" },
        completed: { character: "●", awaitingReviewCharacter: "○" },
        paused: { character: "⏸" },
        deleted: { character: "⌫" } } });
  });

  it("merges a partial nested glyph config with defaults", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ glyphs: { inProgress: { character: "▶" } } }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config).toEqual({
      maxAttempts: 8,
      enableAssignee: false,
      glyphs: {
        inProgress: { character: "▶", frames: ["▶", " "] },
        pending: { character: "◌", retriedCharacter: "■" },
        completed: { character: "●", awaitingReviewCharacter: "○" },
        paused: { character: "⏸" },
        deleted: { character: "⌫" } } });
    expect(messages).toEqual([]);
  });

  it("merges review glyphs and animation frames per field", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({
      glyphs: {
        inProgress: { character: "legacy", frames: ["1", "2"] },
        pending: { retriedCharacter: "R" },
        completed: { awaitingReviewCharacter: "A" } } }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.glyphs.inProgress).toEqual({ character: "legacy", frames: ["1", "2"] });
    expect(config.glyphs.pending).toEqual({ character: "◌", retriedCharacter: "R" });
    expect(config.glyphs.completed).toEqual({ character: "●", awaitingReviewCharacter: "A" });
    expect(messages).toEqual([]);
  });

  it("preserves character-only intent when the explicit character equals the default", async () => {
    const dir = await agentDir();
    const path = join(dir, "default-character.json");
    await writeFile(path, JSON.stringify({ glyphs: { inProgress: { character: "⠁" } } }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.glyphs.inProgress).toEqual({ character: "⠁", frames: ["⠁", " "] });
    expect(messages).toEqual([]);
  });

  it("normalizes explicit default-valued pending/completed character overrides", async () => {
    const dir = await agentDir();
    const path = join(dir, "default-status-characters.json");
    await writeFile(path, JSON.stringify({
      glyphs: {
        pending: { character: "◌" },
        completed: { character: "●" } } }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.glyphs.pending).toEqual({ character: "◌", retriedCharacter: "◌" });
    expect(config.glyphs.completed).toEqual({ character: "●", awaitingReviewCharacter: "●" });
    expect(messages).toEqual([]);
  });

  it("rejects mixed-width frames and falls back to the default frames even when character is present", async () => {
    const dir = await agentDir();
    const path = join(dir, "mixed-width-frames.json");
    await writeFile(path, JSON.stringify({ glyphs: { inProgress: { character: "▶", frames: ["x", "界"] } } }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.glyphs.inProgress.character).toBe("▶");
    expect(config.glyphs.inProgress.frames).toEqual(DEFAULT_CONFIG.glyphs.inProgress.frames);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("equal-width");
  });

  it("accepts maxAttempts 0 as the unlimited sentinel", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ maxAttempts: 0 }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.maxAttempts).toBe(0);
    expect(config.glyphs).toEqual(DEFAULT_CONFIG.glyphs);
    expect(messages).toEqual([]);
  });

  it("accepts large maxAttempts with no upper cap, including Number.MAX_SAFE_INTEGER", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    for (const maxAttempts of [16, 17, 100, Number.MAX_SAFE_INTEGER]) {
      const okPath = join(dir, `attempts-${String(maxAttempts)}.json`);
      await writeFile(okPath, JSON.stringify({ maxAttempts }));
      expect(loadPiTasksConfig(okPath, warn).maxAttempts).toBe(maxAttempts);
    }
    expect(messages).toEqual([]);
  });

  it("falls back with a warning for unsafe, non-integer, or negative maxAttempts", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    const overPath = join(dir, "unsafe.json");
    await writeFile(overPath, JSON.stringify({ maxAttempts: Number.MAX_SAFE_INTEGER + 1 }));
    expect(loadPiTasksConfig(overPath, warn).maxAttempts).toBe(8);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(overPath);
    expect(messages[0]).toContain("non-negative safe integer");
  });

  it("warns and uses defaults for malformed JSON", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, "{oops");
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(path, warn)).toEqual(DEFAULT_CONFIG);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(path);
    expect(messages[0]).toContain("defaults");
  });

  it("warns per invalid field and falls back safely for just that value", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        maxAttempts: -1,
        glyphs: {
          inProgress: { character: "▶" },
          pending: { character: "" },
          completed: "x" } }),
    );
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(path, warn)).toEqual({
      maxAttempts: 8,
      enableAssignee: false,
      glyphs: {
        inProgress: { character: "▶", frames: ["▶", " "] },
        pending: { character: "◌", retriedCharacter: "■" },
        completed: { character: "●", awaitingReviewCharacter: "○" },
        paused: { character: "⏸" },
        deleted: { character: "⌫" } } });
    expect(messages.length).toBeGreaterThanOrEqual(3);
    for (const message of messages) expect(message).toContain(path);
  });

  it("rejects non-object roots, non-object glyphs, and invalid integer shapes", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    const arrayPath = join(dir, "array.json");
    await writeFile(arrayPath, "[1, 2]");
    expect(loadPiTasksConfig(arrayPath, warn)).toEqual(DEFAULT_CONFIG);

    const glyphsPath = join(dir, "glyphs.json");
    await writeFile(glyphsPath, JSON.stringify({ glyphs: [] }));
    expect(loadPiTasksConfig(glyphsPath, warn)).toEqual(DEFAULT_CONFIG);

    for (const maxAttempts of [1.5, Number.MAX_SAFE_INTEGER + 1, "9", -2]) {
      const invalidPath = join(dir, `invalid-${String(maxAttempts)}.json`);
      await writeFile(invalidPath, JSON.stringify({ maxAttempts }));
      expect(loadPiTasksConfig(invalidPath, warn).maxAttempts).toBe(8);
    }
    expect(messages.length).toBeGreaterThanOrEqual(6);
  });

  it("rejects glyph characters with line breaks and zero-width/combining-only content", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        glyphs: {
          inProgress: { character: "bad\nglyph" },
          pending: { character: "\u0301" },
          completed: { character: "\u200b" } } }),
    );
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.glyphs).toEqual(DEFAULT_CONFIG.glyphs);
    expect(messages).toHaveLength(3);
    for (const message of messages) expect(message).toContain(path);
  });

  it("permits ordinary multi-character and wide printable glyphs", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ glyphs: { inProgress: { character: ">>" }, pending: { character: "🔥" } } }),
    );
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.glyphs.inProgress.character).toBe(">>");
    expect(config.glyphs.pending.character).toBe("🔥");
    expect(config.glyphs.completed).toEqual(DEFAULT_CONFIG.glyphs.completed);
    expect(messages).toEqual([]);
  });

  it("warns on unknown keys while preserving recognized valid fields", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        defaultMaxAttempt: 3,
        defaultMaxAttempts: 9,
        maxAttempts: 5,
        glyphs: {
          in_progress: { character: "x" },
          inProgress: { character: "▶", colour: "red" },
          pending: { character: "○" } } }),
    );
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.maxAttempts).toBe(5);
    expect(config.glyphs.inProgress.character).toBe("▶");
    expect(config.glyphs.pending.character).toBe("○");
    expect(config.glyphs.completed).toEqual(DEFAULT_CONFIG.glyphs.completed);
    expect(messages).toHaveLength(4);
    expect(messages.join("\n")).toContain("defaultMaxAttempt");
    expect(messages.join("\n")).toContain("defaultMaxAttempts");
    expect(messages.join("\n")).toContain("in_progress");
    expect(messages.join("\n")).toContain("colour");
    for (const message of messages) expect(message).toContain(path);
  });

  it("ignores the removed defaultMaxAttempts key as unknown and keeps maxAttempts at default 8", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ defaultMaxAttempts: 3 }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.maxAttempts).toBe(8);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('unknown config key "defaultMaxAttempts"');
    expect(messages[0]).toContain(path);
  });

  it("accepts the new maxAttempts key", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ maxAttempts: 3 }));
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(path, warn).maxAttempts).toBe(3);
    expect(messages).toEqual([]);
  });

  it("defaults enableAssignee to false", async () => {
    expect(DEFAULT_CONFIG.enableAssignee).toBe(false);
    const dir = await agentDir();
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(join(dir, "missing.json"), warn).enableAssignee).toBe(false);
    expect(messages).toEqual([]);
  });

  it("accepts enableAssignee true", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ enableAssignee: true }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.enableAssignee).toBe(true);
    expect(config.maxAttempts).toBe(8);
    expect(messages).toEqual([]);
  });

  it("warns and falls back to false for non-boolean enableAssignee", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    for (const enableAssignee of ["yes", 1, 0, null, {}, []]) {
      const invalidPath = join(dir, `assignee-${JSON.stringify(enableAssignee)}.json`);
      await writeFile(invalidPath, JSON.stringify({ enableAssignee }));
      const config = loadPiTasksConfig(invalidPath, warn);
      expect(config.enableAssignee).toBe(false);
      expect(config.maxAttempts).toBe(8);
    }
    expect(messages).toHaveLength(6);
    for (const message of messages) {
      expect(message).toContain("enableAssignee");
      expect(message).toContain("boolean");
    }
  });

  it("warns and uses defaults when the file cannot be read", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(dir, warn)).toEqual(DEFAULT_CONFIG);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(dir);
  });

  it("has no defaultColor in the config shape", async () => {
    const dir = await agentDir();
    const { warn } = collector();
    const config = loadPiTasksConfig(join(dir, "missing.json"), warn);
    for (const glyph of Object.values(config.glyphs)) {
      expect("defaultColor" in glyph).toBe(false);
    }
  });

  it("tolerates legacy glyph defaultColor keys without crashing", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        glyphs: {
          inProgress: { character: "▶", defaultColor: "red" },
          pending: { character: "○", defaultColor: "blue" },
          completed: { character: "✔", defaultColor: "yellow" },
          paused: { character: "✖", defaultColor: "red" } } }),
    );
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.glyphs.inProgress.character).toBe("▶");
    expect(config.glyphs.pending.character).toBe("○");
    expect(config.glyphs.completed.character).toBe("✔");
    expect(config.glyphs.paused.character).toBe("✖");
    for (const glyph of Object.values(config.glyphs)) {
      expect("defaultColor" in glyph).toBe(false);
    }
    for (const message of messages) expect(message).toContain(path);
  });
});
