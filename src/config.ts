/**
 * pi-tasks configuration.
 *
 * Loaded once from `join(getAgentDir(), "extensions", "pi-tasks.json")`
 * (i.e. `$PI_CODING_AGENT_DIR/extensions/pi-tasks.json`) when the extension
 * registers. A missing file or missing fields fall back to {@link DEFAULT_CONFIG};
 * malformed JSON or invalid fields warn (via the supplied warn callback) and
 * fall back safely for just the offending value, never crashing startup.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface PiTasksConfig {
  /**
   * Per-task attempt cap used when task_create creates a task.
   * Always a non-negative safe integer; 0 means unlimited attempts.
   */
  maxAttempts: number;
  /**
   * Whether assignment input, prompt guidance, and assignment display are
   * enabled. Defaults to false.
   */
  enableAssignment: boolean;
  /**
   * Whether the `<task-management>` policy block is appended to the system
   * prompt in `before_agent_start`. Defaults to true; when false, no
   * system-prompt handler is registered while tool `promptSnippet` and
   * summary descriptions stay unchanged.
   */
  injectGuidelines: boolean;
}

/** Centralized defaults. */
export const DEFAULT_CONFIG: PiTasksConfig = {
  maxAttempts: 8,
  enableAssignment: false,
  injectGuidelines: true,
};

/**
 * Attempt-limit bounds for newly configured/created tasks. There is no hard
 * upper cap: `maxAttempts` accepts any non-negative safe integer
 * (0 means unlimited). Persisted records load unchanged under the same
 * non-negative safe-integer rule; the widget renders their exact remaining-attempt count.
 */

const ROOT_KEYS = new Set([
  "maxAttempts",
  "enableAssignment",
  "injectGuidelines",
]);

/** Resolve the config file path for an agent dir (defaults to `getAgentDir()`). */
export function configFilePath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "extensions", "pi-tasks.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig(config: PiTasksConfig): PiTasksConfig {
  return {
    maxAttempts: config.maxAttempts,
    enableAssignment: config.enableAssignment,
    injectGuidelines: config.injectGuidelines,
  };
}

/**
 * Load the pi-tasks config. Never throws for missing/malformed/invalid
 * files: warns per problem and falls back to {@link DEFAULT_CONFIG} values.
 */
export function loadPiTasksConfig(
  configPath: string = configFilePath(),
  warn: (message: string) => void = (message) => console.warn(message),
): PiTasksConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if (
      isRecord(error) &&
      typeof error.code === "string" &&
      error.code === "ENOENT"
    )
      return config;
    warn(
      `pi-tasks: cannot read config at ${configPath}, using defaults: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return config;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    warn(
      `pi-tasks: invalid JSON in config at ${configPath}, using defaults: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return config;
  }
  if (!isRecord(data)) {
    warn(
      `pi-tasks: invalid config at ${configPath}, using defaults: expected an object.`,
    );
    return config;
  }

  for (const key of Object.keys(data)) {
    if (!ROOT_KEYS.has(key)) {
      warn(`pi-tasks: unknown config key "${key}" at ${configPath}, ignoring.`);
    }
  }

  if (data.maxAttempts !== undefined) {
    if (
      typeof data.maxAttempts === "number" &&
      Number.isSafeInteger(data.maxAttempts) &&
      data.maxAttempts >= 0 &&
      data.maxAttempts <= Number.MAX_SAFE_INTEGER
    ) {
      config.maxAttempts = data.maxAttempts;
    } else {
      warn(
        `pi-tasks: invalid config at ${configPath}, using default maxAttempts (${DEFAULT_CONFIG.maxAttempts}): expected a non-negative safe integer (0 means unlimited), got ${JSON.stringify(data.maxAttempts)}.`,
      );
    }
  }

  if (data.enableAssignment !== undefined) {
    if (typeof data.enableAssignment === "boolean") {
      config.enableAssignment = data.enableAssignment;
    } else {
      warn(
        `pi-tasks: invalid config at ${configPath}, using default enableAssignment (${DEFAULT_CONFIG.enableAssignment}): expected a boolean, got ${JSON.stringify(data.enableAssignment)}.`,
      );
    }
  }

  if (data.injectGuidelines !== undefined) {
    if (typeof data.injectGuidelines === "boolean") {
      config.injectGuidelines = data.injectGuidelines;
    } else {
      warn(
        `pi-tasks: invalid config at ${configPath}, using default injectGuidelines (${DEFAULT_CONFIG.injectGuidelines}): expected a boolean, got ${JSON.stringify(data.injectGuidelines)}.`,
      );
    }
  }

  return config;
}
