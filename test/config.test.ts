import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configFilePath,
  DEFAULT_CONFIG,
  loadPiTasksConfig,
} from "../src/config.js";

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
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
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
    expect(configFilePath("/tmp/agent")).toBe(
      join("/tmp/agent", "extensions", "pi-tasks.json"),
    );
  });
});

describe("loadPiTasksConfig", () => {
  it("uses defaults when the file is missing without warning", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    expect(
      loadPiTasksConfig(join(dir, "extensions", "pi-tasks.json"), warn),
    ).toEqual(DEFAULT_CONFIG);
    expect(messages).toEqual([]);
  });

  it("returns a fresh copy so callers cannot mutate the defaults", async () => {
    const dir = await agentDir();
    const { warn } = collector();
    const loaded = loadPiTasksConfig(join(dir, "missing.json"), warn);
    loaded.maxAttempts = 0;
    expect(DEFAULT_CONFIG).toEqual({
      maxAttempts: 8,
      enableAssignment: false,
      injectGuidelines: true,
    });
  });

  it("accepts maxAttempts 0 as the unlimited sentinel", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ maxAttempts: 0 }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.maxAttempts).toBe(0);
    expect(config).toEqual({ ...DEFAULT_CONFIG, maxAttempts: 0 });
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
    await writeFile(
      overPath,
      JSON.stringify({ maxAttempts: Number.MAX_SAFE_INTEGER + 1 }),
    );
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
        enableAssignment: "yes",
      }),
    );
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(path, warn)).toEqual({
      maxAttempts: 8,
      enableAssignment: false,
      injectGuidelines: true,
    });
    expect(messages).toHaveLength(2);
    for (const message of messages) expect(message).toContain(path);
  });

  it("rejects non-object roots and invalid integer shapes", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    const arrayPath = join(dir, "array.json");
    await writeFile(arrayPath, "[1, 2]");
    expect(loadPiTasksConfig(arrayPath, warn)).toEqual(DEFAULT_CONFIG);

    for (const maxAttempts of [1.5, Number.MAX_SAFE_INTEGER + 1, "9", -2]) {
      const invalidPath = join(dir, `invalid-${String(maxAttempts)}.json`);
      await writeFile(invalidPath, JSON.stringify({ maxAttempts }));
      expect(loadPiTasksConfig(invalidPath, warn).maxAttempts).toBe(8);
    }
    expect(messages.length).toBeGreaterThanOrEqual(5);
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
      }),
    );
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.maxAttempts).toBe(5);
    expect(messages).toHaveLength(2);
    expect(messages.join("\n")).toContain("defaultMaxAttempt");
    expect(messages.join("\n")).toContain("defaultMaxAttempts");
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

  it("defaults enableAssignment to false", async () => {
    expect(DEFAULT_CONFIG.enableAssignment).toBe(false);
    const dir = await agentDir();
    const { messages, warn } = collector();
    expect(
      loadPiTasksConfig(join(dir, "missing.json"), warn).enableAssignment,
    ).toBe(false);
    expect(messages).toEqual([]);
  });

  it("accepts enableAssignment true", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ enableAssignment: true }));
    const { messages, warn } = collector();
    const config = loadPiTasksConfig(path, warn);
    expect(config.enableAssignment).toBe(true);
    expect(config.maxAttempts).toBe(8);
    expect(messages).toEqual([]);
  });

  it("warns and ignores the unknown enableAssignee key like any unsupported key", async () => {
    const dir = await agentDir();
    const path = join(dir, "extensions", "pi-tasks.json");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(path, JSON.stringify({ enableAssignee: true }));
    const { messages, warn } = collector();
    expect(loadPiTasksConfig(path, warn).enableAssignment).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('unknown config key "enableAssignee"');
  });

  it("warns and falls back to false for non-boolean enableAssignment", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    for (const enableAssignment of ["yes", 1, 0, null, {}, []]) {
      const invalidPath = join(
        dir,
        `assignment-${JSON.stringify(enableAssignment)}.json`,
      );
      await writeFile(invalidPath, JSON.stringify({ enableAssignment }));
      const config = loadPiTasksConfig(invalidPath, warn);
      expect(config.enableAssignment).toBe(false);
      expect(config.maxAttempts).toBe(8);
    }
    expect(messages).toHaveLength(6);
    for (const message of messages) {
      expect(message).toContain("enableAssignment");
      expect(message).toContain("boolean");
    }
  });

  it("defaults injectGuidelines to true", async () => {
    expect(DEFAULT_CONFIG.injectGuidelines).toBe(true);
    const dir = await agentDir();
    const { messages, warn } = collector();
    expect(
      loadPiTasksConfig(join(dir, "missing.json"), warn).injectGuidelines,
    ).toBe(true);
    expect(messages).toEqual([]);
  });

  it("accepts injectGuidelines true and false", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    for (const injectGuidelines of [true, false]) {
      const path = join(dir, `guidelines-${String(injectGuidelines)}.json`);
      await writeFile(path, JSON.stringify({ injectGuidelines }));
      const config = loadPiTasksConfig(path, warn);
      expect(config.injectGuidelines).toBe(injectGuidelines);
      expect(config.maxAttempts).toBe(8);
    }
    expect(messages).toEqual([]);
  });

  it("warns and falls back to true for non-boolean injectGuidelines", async () => {
    const dir = await agentDir();
    const { messages, warn } = collector();
    for (const injectGuidelines of ["yes", 1, 0, null, {}, []]) {
      const invalidPath = join(
        dir,
        `guidelines-${JSON.stringify(injectGuidelines)}.json`,
      );
      await writeFile(invalidPath, JSON.stringify({ injectGuidelines }));
      const config = loadPiTasksConfig(invalidPath, warn);
      expect(config.injectGuidelines).toBe(true);
      expect(config.maxAttempts).toBe(8);
    }
    expect(messages).toHaveLength(6);
    for (const message of messages) {
      expect(message).toContain("injectGuidelines");
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
});
