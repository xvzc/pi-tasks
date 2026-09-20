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
    loaded.defaultMaxAttempts = 0;
    loaded.glyphs.pending.character = "x";
    expect(DEFAULT_CONFIG).toEqual({
      defaultMaxAttempts: 9,
      glyphs: {
        inProgress: { character: "■", defaultColor: "green" },
        pending: { character: "■", defaultColor: "grey" },
        completed: { character: "■", defaultColor: "green" },
      },
    });
  });

  it("merges a partial nested glyph config with defaults", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ glyphs: { inProgress: { character: "▶" } } }));
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(path, warn)).toEqual({
      defaultMaxAttempts: 9,
      glyphs: {
        inProgress: { character: "▶", defaultColor: "green" },
        pending: { character: "■", defaultColor: "grey" },
        completed: { character: "■", defaultColor: "green" },
      },
    });
    expect(messages).toEqual([]);
  });

  it("accepts defaultMaxAttempts 0 as the unlimited sentinel", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ defaultMaxAttempts: 0 }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.defaultMaxAttempts).toBe(0);
    expect(config.glyphs).toEqual(DEFAULT_CONFIG.glyphs);
    expect(messages).toEqual([]);
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
        defaultMaxAttempts: -1,
        glyphs: {
          inProgress: { character: "▶", defaultColor: "red" },
          pending: { character: "", defaultColor: 42 },
          completed: "x",
        },
      }),
    );
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(path, warn)).toEqual({
      defaultMaxAttempts: 9,
      glyphs: {
        inProgress: { character: "▶", defaultColor: "red" },
        pending: { character: "■", defaultColor: "grey" },
        completed: { character: "■", defaultColor: "green" },
      },
    });
    expect(messages.length).toBeGreaterThanOrEqual(4);
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

    for (const defaultMaxAttempts of [1.5, Number.MAX_SAFE_INTEGER + 1, "9", -2]) {
      const invalidPath = join(dir, `invalid-${String(defaultMaxAttempts)}.json`);
      await writeFile(invalidPath, JSON.stringify({ defaultMaxAttempts }));
      expect(loadPiTasksConfig(invalidPath, warn).defaultMaxAttempts).toBe(9);
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
          completed: { character: "\u200b" },
        },
      }),
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
        defaultMaxAttempts: 5,
        glyphs: {
          in_progress: { character: "x" },
          inProgress: { character: "▶", colour: "red" },
          pending: { character: "○" },
        },
      }),
    );
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.defaultMaxAttempts).toBe(5);
    expect(config.glyphs.inProgress.character).toBe("▶");
    expect(config.glyphs.inProgress.defaultColor).toBe("green");
    expect(config.glyphs.pending.character).toBe("○");
    expect(config.glyphs.completed).toEqual(DEFAULT_CONFIG.glyphs.completed);
    expect(messages).toHaveLength(3);
    expect(messages.join("\n")).toContain("defaultMaxAttempt");
    expect(messages.join("\n")).toContain("in_progress");
    expect(messages.join("\n")).toContain("colour");
    for (const message of messages) expect(message).toContain(path);
  });

  it("warns and uses defaults when the file cannot be read", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(dir, warn)).toEqual(DEFAULT_CONFIG);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(dir);
  });
});
