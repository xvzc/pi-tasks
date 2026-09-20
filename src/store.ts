/**
 * Per-main-session file-backed task store.
 *
 * File layout: `<cwd>/.pi/tasks/tasks-{sanitizedSessionId}.json`
 * Envelope: `{ version: 1, nextId, tasks }`.
 *
 * Rules:
 * - IDs allocate monotonically from `nextId`; deleted IDs are never reused.
 * - Writes are atomic (temp file + rename).
 * - Dependency invariants are enforced on every mutation: references must
 *   exist, no self-reference, no cycles, and entering `in_progress` requires
 *   all dependencies to be completed.
 * - `metadata` updates shallow-merge and `appendLog` appends a timestamped
 *   execution note. `assignee: null` / `color: null` remove those fields.
 *   Successful updates refresh `updatedAt` and never touch
 *   `createdAt`. Completed tasks may return to `pending`.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "./config.js";
import { isTaskStatus, type StoreData, type Task, type TaskLogEntry, type TaskStatus } from "./types.js";

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

/** Deterministic, filename-safe, collision-resistant encoding for session IDs. */
export function sanitizeSessionId(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "session";
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `${readable}-${digest}`;
}

/** Resolve the per-session store file for a working directory + session ID. */
export function taskFilePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "tasks", `tasks-${sanitizeSessionId(sessionId)}.json`);
}

export function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6])
  );
}

const STORE_KEYS = new Set(["version", "nextId", "tasks", "totalActiveMs", "activeSince"]);
const TASK_KEYS = new Set([
  "id",
  "status",
  "attempt",
  "maxAttempts",
  "createdAt",
  "updatedAt",
  "startedAt",
  "tookMs",
  "subject",
  "description",
  "assignee",
  "color",
  "blockedBy",
  "metadata",
  "log",
]);

function assertNoPrefix(value: Record<string, unknown>): void {
  if ("prefix" in value) {
    throw new TaskError("`prefix` was renamed to `assignee`; use `assignee`.");
  }
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TaskError(`${label} contains unknown key: ${unknown[0]}.`);
}

const LOG_ENTRY_KEYS = new Set(["timestamp", "message"]);

function parseTaskLog(raw: unknown): TaskLogEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new TaskError("Persisted task log must be an array.");
  return raw.map((entry) => {
    // Compatibility with the short-lived timestamp-prefixed string format.
    if (typeof entry === "string") {
      const separator = entry.indexOf(" ");
      const timestamp = separator < 0 ? "" : entry.slice(0, separator);
      const message = separator < 0 ? "" : entry.slice(separator + 1).trim();
      if (!isUtcTimestamp(timestamp) || message.length === 0) {
        throw new TaskError("Persisted task log entries must contain a valid timestamp and non-empty message.");
      }
      return { timestamp, message };
    }
    if (!isRecord(entry)) {
      throw new TaskError("Persisted task log entries must be objects.");
    }
    assertOnlyKeys(entry, LOG_ENTRY_KEYS, "Persisted task log entry");
    if (!isUtcTimestamp(entry.timestamp) || typeof entry.message !== "string" || entry.message.trim().length === 0) {
      throw new TaskError("Persisted task log entries must contain a valid timestamp and non-empty message.");
    }
    return { timestamp: entry.timestamp, message: entry.message };
  });
}

function cloneLog(log: TaskLogEntry[]): TaskLogEntry[] {
  return log.map((entry) => ({ ...entry }));
}

function parseTask(raw: unknown): Task {
  if (!isRecord(raw)) throw new TaskError("Each persisted task must be an object.");
  assertOnlyKeys(raw, TASK_KEYS, "Persisted task");
  assertValidId(raw.id as number);
  if (typeof raw.maxAttempts !== "number" || !Number.isSafeInteger(raw.maxAttempts) || raw.maxAttempts < 0) {
    throw new TaskError("Persisted task maxAttempts must be a non-negative safe integer.");
  }
  if (typeof raw.attempt !== "number" || !Number.isSafeInteger(raw.attempt) || raw.attempt < 0) {
    throw new TaskError("Persisted task attempt must be a non-negative safe integer.");
  }
  if ((raw.maxAttempts as number) > 0 && (raw.attempt as number) > (raw.maxAttempts as number)) {
    throw new TaskError("Persisted task attempt must not exceed maxAttempts.");
  }
  if (typeof raw.subject !== "string" || raw.subject.trim().length === 0) {
    throw new TaskError("Persisted task subject must be a non-empty string.");
  }
  if (typeof raw.description !== "string") throw new TaskError("Persisted task description must be a string.");
  if (!isTaskStatus(raw.status)) throw new TaskError(`Invalid persisted task status: ${String(raw.status)}.`);
  if (!Array.isArray(raw.blockedBy)) throw new TaskError("Persisted task blockedBy must be an array of task ids.");
  assertIdList(raw.blockedBy as number[]);
  if (!isRecord(raw.metadata)) throw new TaskError("Persisted task metadata must be an object.");
  const log = parseTaskLog(raw.log);
  if (!isUtcTimestamp(raw.createdAt) || !isUtcTimestamp(raw.updatedAt)) {
    throw new TaskError("Persisted task timestamps must be valid ISO 8601 UTC strings.");
  }
  if ("assignee" in raw && typeof raw.assignee !== "string") {
    throw new TaskError("Persisted task assignee must be a string.");
  }
  if ("color" in raw && typeof raw.color !== "string") {
    throw new TaskError("Persisted task color must be a string.");
  }

  const task: Task = {
    id: raw.id as number,
    subject: raw.subject,
    description: raw.description,
    status: raw.status,
    attempt: raw.attempt as number,
    maxAttempts: raw.maxAttempts as number,
    blockedBy: [...(raw.blockedBy as number[])],
    metadata: { ...raw.metadata },
    log,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (typeof raw.assignee === "string") task.assignee = raw.assignee;
  if (typeof raw.color === "string") task.color = raw.color;
  if ("startedAt" in raw && raw.startedAt !== undefined) {
    if (!isUtcTimestamp(raw.startedAt)) {
      throw new TaskError("Persisted task startedAt must be a valid ISO 8601 UTC string.");
    }
    task.startedAt = raw.startedAt;
  }
  if ("tookMs" in raw && raw.tookMs !== undefined) {
    if (typeof raw.tookMs !== "number" || !Number.isSafeInteger(raw.tookMs) || raw.tookMs < 0) {
      throw new TaskError("Persisted task tookMs must be a non-negative safe integer.");
    }
    task.tookMs = raw.tookMs;
  }
  return task;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

export interface TaskCreateInput {
  subject: string;
  description: string;
  assignee?: string;
  color?: string;
  blockedBy?: number[];
  metadata?: Record<string, unknown>;
  /**
   * Explicit per-task attempt cap. Must be a positive safe integer when
   * present; omit it to use the configured default (which may be 0 for
   * unlimited attempts). 0 cannot be set explicitly.
   */
  maxAttempts?: number;
}

export interface TaskPatch {
  subject?: string;
  description?: string;
  /** `null` removes the field. */
  assignee?: string | null;
  /** `null` removes the field. */
  color?: string | null;
  status?: TaskStatus;
  /** Full replacement of the dependency list. */
  blockedBy?: number[];
  /** Shallow-merged into the existing metadata. */
  metadata?: Record<string, unknown>;
  /** Append one non-empty execution note; the store prefixes its timestamp. */
  appendLog?: string;
  /** Never present: `attempt` and `maxAttempts` are immutable and excluded from updates. */
}

export type TaskStoreWriter = (filePath: string, data: StoreData) => Promise<void>;

async function writeStoreData(filePath: string, data: StoreData): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, filePath);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export class TaskStore {
  private tasks = new Map<number, Task>();
  private nextId = 1;
  private totalActiveMs = 0;
  private activeSince: string | undefined;

  constructor(readonly filePath: string, private readonly writer: TaskStoreWriter = writeStoreData) {}

  /** Wall-clock union timing: finished active milliseconds plus the running period (if any). */
  activeTiming(): { totalActiveMs: number; activeSince?: string } {
    return this.activeSince === undefined
      ? { totalActiveMs: this.totalActiveMs }
      : { totalActiveMs: this.totalActiveMs, activeSince: this.activeSince };
  }

  /** Load and fully validate a store from disk. A missing file yields an empty store. */
  static async load(filePath: string, writer: TaskStoreWriter = writeStoreData): Promise<TaskStore> {
    const store = new TaskStore(filePath, writer);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return store;
      throw error;
    }

    try {
      const data: unknown = JSON.parse(raw);
      if (!isRecord(data)) throw new TaskError("Persisted task store must be an object.");
      assertOnlyKeys(data, STORE_KEYS, "Persisted task store");
      if (data.version !== 1) throw new TaskError(`Unsupported persisted task store version: ${String(data.version)}.`);
      if (!Array.isArray(data.tasks)) throw new TaskError("Persisted task store tasks must be an array.");
      if (
        typeof data.nextId !== "number" ||
        !Number.isSafeInteger(data.nextId) ||
        data.nextId <= 0
      ) {
        throw new TaskError("Persisted task store nextId must be a positive safe integer.");
      }

      const tasks = new Map<number, Task>();
      for (const entry of data.tasks) {
        const task = parseTask(entry);
        if (tasks.has(task.id)) throw new TaskError(`Duplicate persisted task id: #${task.id}.`);
        tasks.set(task.id, task);
      }
      const maxId = Math.max(0, ...tasks.keys());
      if (data.nextId <= maxId) {
        throw new TaskError(`Persisted task store nextId must be greater than every task id.`);
      }
      validateDependencies(tasks);

      let totalActiveMs = 0;
      let activeSince: string | undefined;
      if ("totalActiveMs" in data && data.totalActiveMs !== undefined) {
        if (typeof data.totalActiveMs !== "number" || !Number.isSafeInteger(data.totalActiveMs) || data.totalActiveMs < 0) {
          throw new TaskError("Persisted task store totalActiveMs must be a non-negative safe integer.");
        }
        totalActiveMs = data.totalActiveMs;
      }
      if ("activeSince" in data && data.activeSince !== undefined) {
        if (!isUtcTimestamp(data.activeSince)) {
          throw new TaskError("Persisted task store activeSince must be a valid ISO 8601 UTC string.");
        }
        activeSince = data.activeSince;
      }

      // Sensible reload reconciliation so timers neither reset nor count
      // stopped periods after restart. Persisted per-task `startedAt` and
      // the global `activeSince` are wall-clock values: preserving them
      // keeps the running attempt and global totals continuous across a
      // restart (downtime while tasks remain `in_progress` counts as
      // active, matching the pre-restart wall clock). Legacy files without
      // timing fields start counting from load time instead of inventing
      // history (each `in_progress` task without `startedAt` starts its
      // attempt at the load timestamp, matching the global `activeSince`
      // load-time behavior), and corrupt states (active marker without an
      // active task, or a `startedAt` on a non-active task) are cleared
      // without adding unknown time.
      const loadNow = nowIso();
      const hasActive = [...tasks.values()].some((task) => task.status === "in_progress");
      for (const task of tasks.values()) {
        if (task.status !== "in_progress") {
          if (task.startedAt !== undefined) delete task.startedAt;
        } else if (task.startedAt === undefined) {
          task.startedAt = loadNow;
        }
      }
      if (hasActive && activeSince === undefined) {
        activeSince = loadNow;
      } else if (!hasActive && activeSince !== undefined) {
        activeSince = undefined;
      }

      store.tasks = tasks;
      store.nextId = data.nextId;
      store.totalActiveMs = totalActiveMs;
      store.activeSince = activeSince;
      return store;
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskError(`Invalid persisted task store: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  /** Atomic write (temp file + rename). Always writes, even when empty, so `nextId` survives. */
  async save(): Promise<void> {
    await this.writeData(this.tasks, this.nextId, this.totalActiveMs, this.activeSince);
  }

  private async writeData(tasks: Map<number, Task>, nextId: number, totalActiveMs: number, activeSince: string | undefined): Promise<void> {
    const data: StoreData = { version: 1, nextId, tasks: [...tasks.values()], totalActiveMs };
    if (activeSince !== undefined) data.activeSince = activeSince;
    await this.writer(this.filePath, data);
  }

  existsOnDisk(): boolean {
    return existsSync(this.filePath);
  }

  list(status?: TaskStatus): Task[] {
    const tasks = [...this.tasks.values()].sort((a, b) => a.id - b.id);
    const filtered = status === undefined ? tasks : tasks.filter((task) => task.status === status);
    return filtered.map((task) => ({ ...task, blockedBy: [...task.blockedBy], metadata: { ...task.metadata }, log: cloneLog(task.log) }));
  }

  get(id: number): Task | undefined {
    assertValidId(id);
    const task = this.tasks.get(id);
    return task === undefined ? undefined : { ...task, blockedBy: [...task.blockedBy], metadata: { ...task.metadata }, log: cloneLog(task.log) };
  }

  /**
   * Create a task. An omitted `maxAttempts` falls back to
   * `defaultMaxAttempts` (a non-negative safe integer; 0 means unlimited).
   * An explicit `maxAttempts` must be a positive safe integer.
   */
  async create(input: TaskCreateInput, defaultMaxAttempts: number = DEFAULT_CONFIG.defaultMaxAttempts): Promise<Task> {
    assertNoPrefix(input as unknown as Record<string, unknown>);
    if (typeof input.subject !== "string" || input.subject.trim().length === 0) {
      throw new TaskError("subject must be a non-empty string.");
    }
    const description = input.description;
    if (typeof description !== "string") throw new TaskError("description must be a string.");
    if (input.assignee !== undefined && typeof input.assignee !== "string") {
      throw new TaskError("assignee must be a string.");
    }
    if (input.color !== undefined && typeof input.color !== "string") {
      throw new TaskError("color must be a string.");
    }
    const blockedBy = input.blockedBy ?? [];
    assertIdList(blockedBy);
    const metadata = input.metadata ?? {};
    if (!isRecord(metadata)) throw new TaskError("metadata must be an object.");
    let maxAttempts: number;
    if (input.maxAttempts !== undefined) {
      assertValidMaxAttempts(input.maxAttempts);
      maxAttempts = input.maxAttempts;
    } else {
      assertValidDefaultMaxAttempts(defaultMaxAttempts);
      maxAttempts = defaultMaxAttempts;
    }

    // An all-completed store resets atomically: validate the new task against
    // a fresh state and commit the replacement envelope (new task #1) with a
    // single temp-file+rename write. Validation or persistence failure leaves
    // the old completed file and in-memory state untouched.
    if (this.tasks.size > 0 && [...this.tasks.values()].every((task) => task.status === "completed")) {
      return this.createReset(input, { description, blockedBy, metadata, maxAttempts });
    }

    const id = this.nextId;
    if (id === Number.MAX_SAFE_INTEGER) {
      throw new TaskError("Task ID space is exhausted; no further tasks can be created.");
    }
    for (const depId of blockedBy) {
      if (depId === id) throw new TaskError(`Task #${id} cannot depend on itself.`);
      if (!this.tasks.has(depId)) throw new TaskError(`Task #${depId} does not exist.`);
    }

    const now = nowIso();
    const task: Task = {
      id,
      subject: input.subject,
      description,
      status: "pending",
      attempt: 0,
      maxAttempts,
      blockedBy: [...blockedBy],
      metadata: { ...metadata },
      log: [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.assignee !== undefined) task.assignee = input.assignee;
    if (input.color !== undefined) task.color = input.color;
    const candidateTasks = cloneTasks(this.tasks);
    candidateTasks.set(id, task);
    const candidateNextId = id + 1;
    // A pending create never changes the active set, so global timing passes through.
    await this.writeData(candidateTasks, candidateNextId, this.totalActiveMs, this.activeSince);
    this.tasks = candidateTasks;
    this.nextId = candidateNextId;
    return { ...task, blockedBy: [...task.blockedBy], metadata: { ...task.metadata }, log: cloneLog(task.log) };
  }

  private async createReset(
    input: TaskCreateInput,
    validated: { description: string; blockedBy: number[]; metadata: Record<string, unknown>; maxAttempts: number },
  ): Promise<Task> {
    const id = 1;
    for (const depId of validated.blockedBy) {
      if (depId === id) throw new TaskError(`Task #${id} cannot depend on itself.`);
      throw new TaskError(`Task #${depId} does not exist.`);
    }
    const now = nowIso();
    const task: Task = {
      id,
      subject: input.subject,
      description: validated.description,
      status: "pending",
      attempt: 0,
      maxAttempts: validated.maxAttempts,
      blockedBy: [],
      metadata: { ...validated.metadata },
      log: [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.assignee !== undefined) task.assignee = input.assignee;
    if (input.color !== undefined) task.color = input.color;
    const candidateTasks = new Map<number, Task>([[id, task]]);
    const candidateNextId = 2;
    validateDependencies(candidateTasks);
    // A reset starts a fresh list: the previous all-completed run's union
    // time stays on disk history only via the replaced file; the new list
    // accumulates from zero.
    await this.writeData(candidateTasks, candidateNextId, 0, undefined);
    this.tasks = candidateTasks;
    this.nextId = candidateNextId;
    this.totalActiveMs = 0;
    this.activeSince = undefined;
    return { ...task, blockedBy: [...task.blockedBy], metadata: { ...task.metadata }, log: cloneLog(task.log) };
  }

  async update(id: number, patch: TaskPatch): Promise<Task> {
    assertValidId(id);
    assertNoPrefix(patch as unknown as Record<string, unknown>);
    if ("attempt" in (patch as Record<string, unknown>)) {
      throw new TaskError("attempt cannot be updated; it increments only on entry into in_progress.");
    }
    if ("maxAttempts" in (patch as Record<string, unknown>)) {
      throw new TaskError("maxAttempts cannot be updated; it is set once at creation.");
    }
    const current = this.tasks.get(id);
    if (!current) throw new TaskError(`Task #${id} does not exist.`);

    const candidateTasks = cloneTasks(this.tasks);
    const task = candidateTasks.get(id) as Task;

    if (patch.subject !== undefined) {
      if (typeof patch.subject !== "string" || patch.subject.trim().length === 0) {
        throw new TaskError("subject must be a non-empty string.");
      }
      task.subject = patch.subject;
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== "string") throw new TaskError("description must be a string.");
      task.description = patch.description;
    }
    if (patch.assignee !== undefined) {
      if (patch.assignee !== null && typeof patch.assignee !== "string") {
        throw new TaskError("assignee must be a string or null.");
      }
      if (patch.assignee === null) delete task.assignee;
      else task.assignee = patch.assignee;
    }
    if (patch.color !== undefined) {
      if (patch.color !== null && typeof patch.color !== "string") {
        throw new TaskError("color must be a string or null.");
      }
      if (patch.color === null) delete task.color;
      else task.color = patch.color;
    }
    if (patch.blockedBy !== undefined) {
      assertIdList(patch.blockedBy);
      task.blockedBy = [...patch.blockedBy];
    }
    if (patch.metadata !== undefined) {
      if (!isRecord(patch.metadata)) throw new TaskError("metadata must be an object.");
      task.metadata = { ...task.metadata, ...patch.metadata };
    }
    if (patch.appendLog !== undefined && (typeof patch.appendLog !== "string" || patch.appendLog.trim().length === 0)) {
      throw new TaskError("appendLog must be a non-empty string.");
    }
    if (patch.status !== undefined) {
      if (!isTaskStatus(patch.status)) throw new TaskError(`Invalid status: ${String(patch.status)}.`);
      if (patch.status === "in_progress" && current.status !== "in_progress") {
        if (current.maxAttempts > 0 && current.attempt >= current.maxAttempts) {
          throw new TaskError(`Task #${id} has reached the maximum number of attempts (${current.maxAttempts}).`);
        }
        if (current.attempt >= Number.MAX_SAFE_INTEGER) {
          throw new TaskError(
            `Task #${id} cannot enter in_progress: attempt counter has reached Number.MAX_SAFE_INTEGER.`,
          );
        }
        task.attempt = current.attempt + 1;
      }
      task.status = patch.status;
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    if (patch.appendLog !== undefined) {
      task.log.push({ timestamp: now, message: patch.appendLog.trim() });
    }
    // Per-attempt timing: the timer starts at zero only on a real
    // non-`in_progress` -> `in_progress` transition and is preserved by
    // `in_progress` -> `in_progress` updates. Completion freezes the
    // attempt duration into `tookMs`; rework clears it so the new attempt
    // starts at zero and the next completion overwrites it.
    if (patch.status === "in_progress" && current.status !== "in_progress") {
      task.startedAt = now;
      delete task.tookMs;
    } else if (patch.status === "completed" && current.status !== "completed") {
      if (current.startedAt !== undefined) {
        task.tookMs = Math.max(0, nowMs - Date.parse(current.startedAt));
      } else if (current.tookMs === undefined) {
        task.tookMs = 0;
      }
      delete task.startedAt;
    } else if (current.status === "in_progress" && patch.status !== undefined && patch.status !== "in_progress" && patch.status !== "completed") {
      delete task.startedAt;
    }

    task.updatedAt = now;
    validateDependencies(candidateTasks);
    const candidateTiming = advanceGlobalTiming(this.tasks, candidateTasks, this.totalActiveMs, this.activeSince, nowMs, now);
    await this.writeData(candidateTasks, this.nextId, candidateTiming.totalActiveMs, candidateTiming.activeSince);
    this.tasks = candidateTasks;
    this.totalActiveMs = candidateTiming.totalActiveMs;
    this.activeSince = candidateTiming.activeSince;
    return { ...task, blockedBy: [...task.blockedBy], metadata: { ...task.metadata }, log: cloneLog(task.log) };
  }

  async delete(id: number): Promise<void> {
    assertValidId(id);
    if (!this.tasks.has(id)) throw new TaskError(`Task #${id} does not exist.`);
    const referencers = [...this.tasks.values()]
      .filter((task) => task.blockedBy.includes(id))
      .map((task) => `#${task.id}`)
      .sort();
    if (referencers.length > 0) {
      throw new TaskError(`Task #${id} cannot be deleted: referenced by ${referencers.join(", ")}.`);
    }
    const candidateTasks = cloneTasks(this.tasks);
    candidateTasks.delete(id);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    // Empty-list reset: deleting the final task discards any running slice
    // and accumulated union time so a fresh list starts from zero. IDs and
    // nextId are preserved. Non-empty deletions keep union accounting.
    const candidateTiming =
      candidateTasks.size === 0
        ? { totalActiveMs: 0, activeSince: undefined as string | undefined }
        : advanceGlobalTiming(this.tasks, candidateTasks, this.totalActiveMs, this.activeSince, nowMs, now);
    await this.writeData(candidateTasks, this.nextId, candidateTiming.totalActiveMs, candidateTiming.activeSince);
    this.tasks = candidateTasks;
    this.totalActiveMs = candidateTiming.totalActiveMs;
    this.activeSince = candidateTiming.activeSince;
  }

  /**
   * Remove every completed task in a single atomic write. References to the
   * removed IDs are stripped from remaining tasks' `blockedBy` arrays so
   * dependency invariants stay valid. Returns the removed IDs (sorted).
   * No write occurs when nothing is completed. Persistence failure leaves
   * in-memory state unchanged.
   */
  async clearCompleted(): Promise<number[]> {
    const removed = [...this.tasks.values()]
      .filter((task) => task.status === "completed")
      .map((task) => task.id)
      .sort((a, b) => a - b);
    if (removed.length === 0) return [];
    const removedSet = new Set(removed);
    const candidateTasks = new Map<number, Task>();
    for (const [id, task] of this.tasks) {
      if (removedSet.has(id)) continue;
      candidateTasks.set(id, {
        ...task,
        blockedBy: task.blockedBy.filter((depId) => !removedSet.has(depId)),
        metadata: { ...task.metadata },
        log: cloneLog(task.log),
      });
    }
    validateDependencies(candidateTasks);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    // Empty-list reset mirrors delete: a fresh list starts from zero.
    // Otherwise only completed tasks left, so the active set is unchanged.
    const candidateTiming =
      candidateTasks.size === 0
        ? { totalActiveMs: 0, activeSince: undefined as string | undefined }
        : advanceGlobalTiming(this.tasks, candidateTasks, this.totalActiveMs, this.activeSince, nowMs, now);
    await this.writeData(candidateTasks, this.nextId, candidateTiming.totalActiveMs, candidateTiming.activeSince);
    this.tasks = candidateTasks;
    this.totalActiveMs = candidateTiming.totalActiveMs;
    this.activeSince = candidateTiming.activeSince;
    return removed;
  }

  /**
   * Remove every task in a single atomic write, reset active timing, and
   * preserve `nextId`. Returns the removed count. No write occurs when
   * already empty. Persistence failure leaves in-memory state unchanged.
   */
  async clearAll(): Promise<number> {
    if (this.tasks.size === 0) return 0;
    const count = this.tasks.size;
    await this.writeData(new Map<number, Task>(), this.nextId, 0, undefined);
    this.tasks = new Map<number, Task>();
    this.totalActiveMs = 0;
    this.activeSince = undefined;
    return count;
  }

}

function countActive(tasks: Map<number, Task>): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.status === "in_progress") count += 1;
  }
  return count;
}

/**
 * Wall-clock union accounting for global active time. The clock runs while
 * at least one task is `in_progress`, stops when none are (adding the
 * finished slice to the total without double-counting concurrency), and
 * resumes from the accumulated value when work restarts. Rework counts as
 * ordinary active time.
 */
function advanceGlobalTiming(
  before: Map<number, Task>,
  after: Map<number, Task>,
  totalActiveMs: number,
  activeSince: string | undefined,
  nowMs: number,
  nowIsoValue: string,
): { totalActiveMs: number; activeSince: string | undefined } {
  const beforeActive = countActive(before);
  const afterActive = countActive(after);
  if (beforeActive > 0 && afterActive > 0) {
    return { totalActiveMs, activeSince: activeSince ?? nowIsoValue };
  }
  if (beforeActive > 0 && afterActive === 0) {
    const startMs = activeSince === undefined ? nowMs : Date.parse(activeSince);
    const slice = Number.isFinite(startMs) ? Math.max(0, nowMs - startMs) : 0;
    return { totalActiveMs: totalActiveMs + slice, activeSince: undefined };
  }
  if (beforeActive === 0 && afterActive > 0) {
    return { totalActiveMs, activeSince: nowIsoValue };
  }
  return { totalActiveMs, activeSince };
}

function cloneTasks(tasks: Map<number, Task>): Map<number, Task> {
  return new Map(
    [...tasks].map(([id, task]) => [
      id,
      { ...task, blockedBy: [...task.blockedBy], metadata: { ...task.metadata }, log: cloneLog(task.log) },
    ]),
  );
}

function validateDependencies(tasks: Map<number, Task>): void {
  for (const task of tasks.values()) {
    for (const depId of task.blockedBy) {
      if (depId === task.id) throw new TaskError(`Task #${task.id} cannot depend on itself.`);
      if (!tasks.has(depId)) throw new TaskError(`Task #${depId} does not exist.`);
    }
    if (task.status === "in_progress") {
      const open = task.blockedBy.filter((depId) => tasks.get(depId)?.status !== "completed");
      if (open.length > 0) {
        throw new TaskError(
          `Task #${task.id} cannot remain in_progress: dependencies not completed: ${open.map((depId) => `#${depId}`).join(", ")}.`,
        );
      }
    }
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (id: number): void => {
    if (visiting.has(id)) throw new TaskError(`Task #${id} is part of a dependency cycle.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const depId of (tasks.get(id) as Task).blockedBy) visit(depId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of tasks.keys()) visit(id);
}

function assertValidMaxAttempts(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TaskError(`Invalid maxAttempts: ${String(value)}. Expected a positive safe integer.`);
  }
}

function assertValidDefaultMaxAttempts(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TaskError(`Invalid defaultMaxAttempts: ${String(value)}. Expected a non-negative safe integer.`);
  }
}

function assertValidId(id: number): void {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new TaskError(`Invalid task id: ${String(id)}. Expected a positive safe integer.`);
  }
}

function assertIdList(ids: number[]): void {
  if (!Array.isArray(ids)) throw new TaskError("blockedBy must be an array of task ids.");
  for (const id of ids) assertValidId(id);
}

export interface TurnStartResult {
  store: TaskStore;
  /**
   * Always false. Kept for backward compatibility: turn start never deletes
   * anything so completed history stays visible across turns. Reset happens
   * atomically inside {@link TaskStore.create} on TaskCreate.
   */
  cleaned: boolean;
}

/**
 * Turn-start lifecycle: load the session store without deleting anything.
 * An all-completed task list survives every turn and remains visible until
 * the next successful TaskCreate atomically replaces it with the new task #1
 * (see {@link TaskStore.create}).
 */
export async function turnStartStore(cwd: string, sessionId: string): Promise<TurnStartResult> {
  const store = await TaskStore.load(taskFilePath(cwd, sessionId));
  return { store, cleaned: false };
}
