/**
 * Per-main-session file-backed task store.
 *
 * File layout: `<cwd>/.pi/tasks/tasks-{sanitizedSessionId}.json`
 * Envelope: `{ version: 2, nextId, tasks, history }` (version 1 remains readable).
 *
 * Rules:
 * - IDs allocate monotonically from `nextId`; deleted IDs are never reused.
 * - Writes are atomic (temp file + rename).
 * - Dependency invariants are enforced on every mutation: references must
 *   exist, no self-reference, no cycles, and entering `in_progress` requires
 *   all dependencies to be completed.
 * - `metadata` updates shallow-merge and `appendLog` appends a timestamped
 *   execution note. `assignee: null` removes that field. Successful updates refresh `updatedAt` and never touch
 *   `createdAt`. Entering `in_progress` from any other state requires a
 *   non-empty `appendLog`; every real status transition (start, pause, resume,
 *   completion, rework, deletion) requires one. Same-status patches need no
 *   log. `paused` tasks may resume via `paused` -> `in_progress` (attempt cap
 *   and completed dependencies enforced) and survive `clearCompleted`.
 *   `deleted` is a terminal tombstone and also survives `clearCompleted`.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "./config.js";
import {
  ALLOWED_TRANSITIONS,
  isTaskStatus,
  type StoreData,
  type Task,
  type TaskHistoryCycle,
  type TaskLogEntry,
  type TaskStatus,
} from "./types.js";

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

const STORE_KEYS_V1 = new Set(["version", "nextId", "tasks", "totalActiveMs", "activeSince"]);
const STORE_KEYS_V2 = new Set(["version", "nextId", "tasks", "history", "totalActiveMs", "activeSince"]);
const HISTORY_CYCLE_KEYS = new Set(["archivedAt", "tasks", "totalActiveMs"]);
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
  "blockedBy",
  "reviewOf",
  "metadata",
  "log",
]);

function assertNoPrefix(value: Record<string, unknown>): void {
  if ("prefix" in value) {
    throw new TaskError("`prefix` was renamed to `assignee`; use `assignee`.");
  }
}

function assertNoColor(value: Record<string, unknown>): void {
  if ("color" in value) {
    throw new TaskError("`color` is no longer supported; glyph colors are fixed by task status.");
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
  // Legacy files may carry a version-1 `color` field. It is ignored and
  // dropped: strip it before key validation so old envelopes still load,
  // and it is never copied onto the in-memory task (writes omit it).
  if ("color" in raw) delete raw.color;
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
  // Legacy compatibility: v1/v2 stores may persist `failed` (mapped to
  // `paused`) or `pending` with attempt > 0 (also `paused`; pending is
  // initial-only and attempt 0 stays pending). Never reject a readable
  // store solely for these old semantics.
  let persistedStatus: unknown = raw.status;
  if (persistedStatus === "failed") persistedStatus = "paused";
  if (!isTaskStatus(persistedStatus)) throw new TaskError(`Invalid persisted task status: ${String(raw.status)}.`);
  let status = persistedStatus as Task["status"];
  if (status === "pending" && typeof raw.attempt === "number" && (raw.attempt as number) > 0) {
    status = "paused";
  }
  if (!Array.isArray(raw.blockedBy)) throw new TaskError("Persisted task blockedBy must be an array of task ids.");
  assertIdList(raw.blockedBy as number[]);
  const reviewOf = raw.reviewOf ?? [];
  if (!Array.isArray(reviewOf)) throw new TaskError("Persisted task reviewOf must be an array of task ids.");
  assertIdList(reviewOf as number[], "reviewOf");
  if (!isRecord(raw.metadata)) throw new TaskError("Persisted task metadata must be an object.");
  const log = parseTaskLog(raw.log);
  if (!isUtcTimestamp(raw.createdAt) || !isUtcTimestamp(raw.updatedAt)) {
    throw new TaskError("Persisted task timestamps must be valid ISO 8601 UTC strings.");
  }
  if ("assignee" in raw && typeof raw.assignee !== "string") {
    throw new TaskError("Persisted task assignee must be a string.");
  }

  const task: Task = {
    id: raw.id as number,
    subject: raw.subject,
    description: raw.description,
    status,
    attempt: raw.attempt as number,
    maxAttempts: raw.maxAttempts as number,
    blockedBy: [...(raw.blockedBy as number[])],
    reviewOf: [...(reviewOf as number[])],
    metadata: { ...raw.metadata },
    log,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (typeof raw.assignee === "string") task.assignee = raw.assignee;
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

function parseHistoryCycle(raw: unknown): TaskHistoryCycle {
  if (!isRecord(raw)) throw new TaskError("Persisted task history cycles must be objects.");
  assertOnlyKeys(raw, HISTORY_CYCLE_KEYS, "Persisted task history cycle");
  if (!isUtcTimestamp(raw.archivedAt)) {
    throw new TaskError("Persisted task history archivedAt must be a valid ISO 8601 UTC string.");
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new TaskError("Persisted task history cycle tasks must be a non-empty array.");
  }
  if (typeof raw.totalActiveMs !== "number" || !Number.isSafeInteger(raw.totalActiveMs) || raw.totalActiveMs < 0) {
    throw new TaskError("Persisted task history totalActiveMs must be a non-negative safe integer.");
  }
  const tasks = new Map<number, Task>();
  for (const entry of raw.tasks) {
    const task = parseTask(entry);
    if (!isArchivableStatus(task.status)) {
      throw new TaskError("Persisted task history may contain only completed or deleted tasks.");
    }
    if (tasks.has(task.id)) throw new TaskError(`Duplicate persisted history task id: #${task.id}.`);
    tasks.set(task.id, task);
  }
  validateDependencies(tasks);
  checkReviewUniqueness(tasks);
  return {
    archivedAt: raw.archivedAt,
    tasks: [...tasks.values()].sort((a, b) => a.id - b.id).map(cloneTask),
    totalActiveMs: raw.totalActiveMs,
  };
}

function cloneHistoryCycle(cycle: TaskHistoryCycle): TaskHistoryCycle {
  return {
    archivedAt: cycle.archivedAt,
    tasks: cycle.tasks.map(cloneTask),
    totalActiveMs: cycle.totalActiveMs,
  };
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

export interface TaskCreateInput {
  subject: string;
  description: string;
  assignee?: string;
  blockedBy?: number[];
  reviewOf?: number[];
  metadata?: Record<string, unknown>;
  /**
   * Explicit per-task attempt cap. Must be a positive safe integer when
   * present; omit it to use the configured default (which may be 0 for
   * unlimited attempts). 0 cannot be set explicitly.
   *
   * @internal Reserved for programmatic callers. Not exposed through the
   * task_create tool schema: the tool rejects any supplied maxAttempts and
   * always applies the configured cap.
   */
  maxAttempts?: number;
}

/** One item in an atomic create batch. Refs are request-local and never persisted. */
export interface TaskCreateBatchInput extends TaskCreateInput {
  ref?: string;
  blockedByRefs?: string[];
  reviewOfRefs?: string[];
}

export interface TaskRefMapping {
  ref: string;
  id: number;
}

export interface TaskCreateManyResult {
  /** Ref-to-ID mappings in allocated (topological) order. */
  created: TaskRefMapping[];
  /** Created tasks in allocated numeric-ID order. */
  tasks: Task[];
}

export interface TaskPatch {
  subject?: string;
  description?: string;
  /** `null` removes the field. */
  assignee?: string | null;
  status?: TaskStatus;
  /** Full replacement of the dependency list. */
  blockedBy?: number[];
  /** Full replacement of the reviewed-writer list. */
  reviewOf?: number[];
  /** Shallow-merged into the existing metadata. */
  metadata?: Record<string, unknown>;
  /** Append one non-empty execution note; the store prefixes its timestamp. */
  appendLog?: string;
  /** Never present: `attempt` and `maxAttempts` are immutable and excluded from updates. */
}

export interface TaskUpdateBatchInput extends TaskPatch {
  id: number;
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
  private history: TaskHistoryCycle[] = [];
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
      if (data.version !== 1 && data.version !== 2) {
        throw new TaskError(`Unsupported persisted task store version: ${String(data.version)}.`);
      }
      assertOnlyKeys(data, data.version === 1 ? STORE_KEYS_V1 : STORE_KEYS_V2, "Persisted task store");
      if (!Array.isArray(data.tasks)) throw new TaskError("Persisted task store tasks must be an array.");
      if (data.version === 2 && !Array.isArray(data.history)) {
        throw new TaskError("Persisted task store history must be an array.");
      }
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
      const history = data.version === 2 ? (data.history as unknown[]).map(parseHistoryCycle) : [];
      const allIds = new Set<number>();
      for (const cycle of history) {
        for (const task of cycle.tasks) {
          if (allIds.has(task.id)) throw new TaskError(`Duplicate persisted task id across history: #${task.id}.`);
          allIds.add(task.id);
        }
      }
      for (const task of tasks.values()) {
        if (allIds.has(task.id)) throw new TaskError(`Duplicate persisted task id across active tasks and history: #${task.id}.`);
        allIds.add(task.id);
      }
      const maxId = Math.max(0, ...allIds);
      if (data.nextId <= maxId) {
        throw new TaskError(`Persisted task store nextId must be greater than every task id.`);
      }
      validateDependencies(tasks);
      checkReviewUniqueness(tasks);

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
      store.history = history;
      store.nextId = data.nextId;
      store.totalActiveMs = totalActiveMs;
      store.activeSince = activeSince;
      return store;
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskError(`Invalid persisted task store: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  /** Atomic write (temp file + rename). Always writes, even when empty, so `nextId` and history survive. */
  async save(): Promise<void> {
    await this.writeData(this.tasks, this.nextId, this.totalActiveMs, this.activeSince);
  }

  private async writeData(
    tasks: Map<number, Task>,
    nextId: number,
    totalActiveMs: number,
    activeSince: string | undefined,
    history: TaskHistoryCycle[] = this.history,
  ): Promise<void> {
    const data: StoreData = {
      version: 2,
      nextId,
      tasks: [...tasks.values()].map(cloneTask),
      history: history.map(cloneHistoryCycle),
      totalActiveMs,
    };
    if (activeSince !== undefined) data.activeSince = activeSince;
    await this.writer(this.filePath, data);
  }

  existsOnDisk(): boolean {
    return existsSync(this.filePath);
  }

  list(status?: TaskStatus): Task[] {
    const tasks = [...this.tasks.values()].sort((a, b) => a.id - b.id);
    const filtered = status === undefined ? tasks : tasks.filter((task) => task.status === status);
    return filtered.map(cloneTask);
  }

  /** Completed cycles retained on disk; returned as defensive deep copies. */
  listHistory(): TaskHistoryCycle[] {
    return this.history.map(cloneHistoryCycle);
  }

  get(id: number): Task | undefined {
    assertValidId(id);
    const task = this.tasks.get(id);
    return task === undefined ? undefined : cloneTask(task);
  }

  /** Create one task through the same atomic batch path used by task_create. */
  async create(input: TaskCreateInput, configuredMaxAttempts: number = DEFAULT_CONFIG.maxAttempts): Promise<Task> {
    const result = await this.createMany([input], configuredMaxAttempts);
    return result.tasks[0];
  }

  /**
   * Create a non-empty batch atomically. Local refs are validated and
   * topologically sorted before IDs are allocated; they never enter Task.
   */
  async createMany(
    inputs: TaskCreateBatchInput[],
    configuredMaxAttempts: number = DEFAULT_CONFIG.maxAttempts,
  ): Promise<TaskCreateManyResult> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new TaskError("tasks must be a non-empty array.");
    }
    const validated = inputs.map((input, index) => validateCreateBatchItem(input, configuredMaxAttempts, index));
    const refToIndex = new Map<string, number>();
    for (const item of validated) {
      if (item.ref === undefined) continue;
      if (refToIndex.has(item.ref)) throw new TaskError(`Duplicate task ref: ${item.ref}.`);
      refToIndex.set(item.ref, item.index);
    }
    for (const item of validated) {
      for (const ref of [...item.blockedByRefs, ...item.reviewOfRefs]) {
        const dependencyIndex = refToIndex.get(ref);
        if (dependencyIndex === undefined) throw new TaskError(`Unknown blockedByRef: ${ref}.`);
        if (dependencyIndex === item.index) throw new TaskError(`Task ref ${ref} cannot depend on itself.`);
      }
    }
    const order = stableTopologicalOrder(validated, refToIndex);

    // Direct creation without a preceding turn-start still archives a fully
    // terminal (completed/deleted) cycle in the same atomic write. IDs remain monotonic.
    const archivesTerminal = this.tasks.size > 0 && [...this.tasks.values()].every((task) => isArchivableStatus(task.status));
    const candidateTasks = archivesTerminal ? new Map<number, Task>() : cloneTasks(this.tasks);
    const firstId = this.nextId;
    if (inputs.length > Number.MAX_SAFE_INTEGER - firstId) {
      throw new TaskError("Task ID space is exhausted; no further tasks can be created.");
    }
    const now = nowIso();
    const candidateHistory = archivesTerminal
      ? [...this.history.map(cloneHistoryCycle), historyCycle(this.tasks, this.totalActiveMs, now)]
      : this.history;
    const indexToId = new Map<number, number>();
    order.forEach((index, offset) => indexToId.set(index, firstId + offset));
    for (const item of validated) {
      const id = indexToId.get(item.index) as number;
      for (const depId of [...item.blockedBy, ...item.reviewOf]) {
        if (depId === id) throw new TaskError(`Task #${id} cannot depend on itself.`);
        if (!candidateTasks.has(depId)) throw new TaskError(`Task #${depId} does not exist.`);
      }
    }
    const createdTasks: Task[] = [];
    const created: TaskRefMapping[] = [];
    for (const index of order) {
      const item = validated[index];
      const id = indexToId.get(index) as number;
      const localDependencies = item.blockedByRefs.map((ref) => indexToId.get(refToIndex.get(ref) as number) as number);
      const localWriters = item.reviewOfRefs.map((ref) => indexToId.get(refToIndex.get(ref) as number) as number);
      const task: Task = {
        id,
        subject: item.subject,
        description: item.description,
        status: "pending",
        attempt: 0,
        maxAttempts: item.maxAttempts,
        blockedBy: [...item.blockedBy, ...localDependencies],
        reviewOf: [...item.reviewOf, ...localWriters],
        metadata: { ...item.metadata },
        log: [],
        createdAt: now,
        updatedAt: now,
      };
      if (item.assignee !== undefined) task.assignee = item.assignee;
      candidateTasks.set(id, task);
      createdTasks.push(task);
      if (item.ref !== undefined) created.push({ ref: item.ref, id });
    }

    validateDependencies(candidateTasks);
    checkReviewUniqueness(candidateTasks);
    const candidateNextId = firstId + inputs.length;
    const candidateTotalActiveMs = archivesTerminal ? 0 : this.totalActiveMs;
    const candidateActiveSince = archivesTerminal ? undefined : this.activeSince;
    await this.writeData(candidateTasks, candidateNextId, candidateTotalActiveMs, candidateActiveSince, candidateHistory);
    this.tasks = candidateTasks;
    this.history = candidateHistory;
    this.nextId = candidateNextId;
    this.totalActiveMs = candidateTotalActiveMs;
    this.activeSince = candidateActiveSince;
    return { created: created.map((mapping) => ({ ...mapping })), tasks: createdTasks.map(cloneTask) };
  }

  /** Update one task through the same atomic batch path used by task_update. */
  async update(id: number, patch: TaskPatch): Promise<Task> {
    const updated = await this.updateMany([{ id, ...patch }]);
    return updated[0];
  }

  /**
   * Apply a non-empty declarative patch set atomically. All plain fields are
   * applied to a cloned proposed state first; lifecycle and dependency rules
   * are then derived from original -> final proposed state, never array order.
   */
  async updateMany(updates: TaskUpdateBatchInput[]): Promise<Task[]> {
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new TaskError("updates must be a non-empty array.");
    }
    const seen = new Set<number>();
    for (const update of updates) {
      if (!isRecord(update)) throw new TaskError("Each update must be an object.");
      assertValidId(update.id);
      if (seen.has(update.id)) throw new TaskError(`Duplicate task update id: #${update.id}.`);
      seen.add(update.id);
    }
    const ordered = [...updates].sort((a, b) => a.id - b.id);
    const candidateTasks = cloneTasks(this.tasks);

    // First pass: validate and apply caller-controlled fields only. Do not
    // inspect dependencies or derive transition side effects in this pass.
    for (const update of ordered) {
      assertNoPrefix(update as unknown as Record<string, unknown>);
      assertNoColor(update as unknown as Record<string, unknown>);
      if ("attempt" in update) {
        throw new TaskError("attempt cannot be updated; it increments only on entry into in_progress.");
      }
      if ("maxAttempts" in update) {
        throw new TaskError("maxAttempts cannot be updated; it is set once at creation.");
      }
      const task = candidateTasks.get(update.id);
      if (!task) throw new TaskError(`Task #${update.id} does not exist.`);
      if (update.subject !== undefined) {
        if (typeof update.subject !== "string" || update.subject.trim().length === 0) {
          throw new TaskError("subject must be a non-empty string.");
        }
        task.subject = update.subject;
      }
      if (update.description !== undefined) {
        if (typeof update.description !== "string") throw new TaskError("description must be a string.");
        task.description = update.description;
      }
      if (update.assignee !== undefined) {
        if (update.assignee !== null && typeof update.assignee !== "string") {
          throw new TaskError("assignee must be a string or null.");
        }
        if (update.assignee === null) delete task.assignee;
        else task.assignee = update.assignee;
      }
      if (update.blockedBy !== undefined) {
        assertIdList(update.blockedBy);
        task.blockedBy = [...update.blockedBy];
      }
      if (update.reviewOf !== undefined) {
        assertIdList(update.reviewOf, "reviewOf");
        task.reviewOf = [...update.reviewOf];
      }
      if (update.metadata !== undefined) {
        if (!isRecord(update.metadata)) throw new TaskError("metadata must be an object.");
        task.metadata = { ...task.metadata, ...update.metadata };
      }
      if (update.appendLog !== undefined && (typeof update.appendLog !== "string" || update.appendLog.trim().length === 0)) {
        throw new TaskError("appendLog must be a non-empty string.");
      }
      if (update.status !== undefined) {
        if (!isTaskStatus(update.status)) throw new TaskError(`Invalid status: ${String(update.status)}.`);
        task.status = update.status;
      }
    }

    // Second pass: derive every side effect from the immutable original state
    // and the complete proposed state using one shared commit timestamp.
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    for (const update of ordered) {
      const current = this.tasks.get(update.id) as Task;
      const task = candidateTasks.get(update.id) as Task;
      const eligibility = transitionEligibility(current, task, candidateTasks, update.appendLog);
      if (!eligibility.allowed) throw new TaskError(eligibility.error);
      if (task.status === "in_progress" && current.status !== "in_progress") {
        task.attempt = current.attempt + 1;
      }
      if (update.appendLog !== undefined) {
        task.log.push({ timestamp: now, message: update.appendLog.trim() });
      }
      if (task.status === "in_progress" && current.status !== "in_progress") {
        task.startedAt = now;
        delete task.tookMs;
      } else if (task.status === "completed" && current.status !== "completed") {
        if (current.startedAt !== undefined) task.tookMs = Math.max(0, nowMs - Date.parse(current.startedAt));
        else if (current.tookMs === undefined) task.tookMs = 0;
        delete task.startedAt;
      } else if (task.status === "paused" && current.status !== "paused") {
        if (current.startedAt !== undefined) task.tookMs = Math.max(0, nowMs - Date.parse(current.startedAt));
        else if (current.tookMs === undefined) task.tookMs = 0;
        delete task.startedAt;
      } else if (task.status === "deleted" && current.status !== "deleted") {
        if (current.startedAt !== undefined) task.tookMs = Math.max(0, nowMs - Date.parse(current.startedAt));
        else if (current.tookMs === undefined) task.tookMs = 0;
        delete task.startedAt;
      } else if (current.status === "in_progress" && task.status !== "in_progress") {
        delete task.startedAt;
      }
      task.updatedAt = now;
    }

    for (const update of ordered) {
      const current = this.tasks.get(update.id) as Task;
      const task = candidateTasks.get(update.id) as Task;
      if (task.status !== "deleted" || current.status === "deleted") continue;
      const referencers = [...candidateTasks.values()]
        .filter((candidate) =>
          candidate.status !== "deleted" &&
          (candidate.blockedBy.includes(task.id) || candidate.reviewOf.includes(task.id))
        )
        .map((candidate) => `#${candidate.id}`)
        .sort();
      if (referencers.length > 0) {
        throw new TaskError(`Task #${task.id} cannot be deleted: referenced by ${referencers.join(", ")}.`);
      }
    }

    validateDependencies(candidateTasks);
    checkReviewUniqueness(candidateTasks);
    const candidateTiming = advanceGlobalTiming(this.tasks, candidateTasks, this.totalActiveMs, this.activeSince, nowMs, now);
    await this.writeData(candidateTasks, this.nextId, candidateTiming.totalActiveMs, candidateTiming.activeSince);
    this.tasks = candidateTasks;
    this.totalActiveMs = candidateTiming.totalActiveMs;
    this.activeSince = candidateTiming.activeSince;
    return ordered.map((update) => cloneTask(candidateTasks.get(update.id) as Task));
  }

  /**
   * Atomically move a non-empty completed/deleted active list into append-only
   * history, reset active timing, and preserve `nextId`.
   */
  async archiveTerminalCycle(): Promise<boolean> {
    if (this.tasks.size === 0 || [...this.tasks.values()].some((task) => !isArchivableStatus(task.status))) return false;
    const candidateHistory = [
      ...this.history.map(cloneHistoryCycle),
      historyCycle(this.tasks, this.totalActiveMs, nowIso()),
    ];
    await this.writeData(new Map<number, Task>(), this.nextId, 0, undefined, candidateHistory);
    this.tasks = new Map<number, Task>();
    this.history = candidateHistory;
    this.totalActiveMs = 0;
    this.activeSince = undefined;
    return true;
  }

  /**
   * Remove unretained completed tasks in a single atomic write. Completed
   * writers reachable from surviving review tasks are retained to a fixed
   * point; removed IDs are stripped from both edge lists. Returns removed IDs
   * sorted. `paused` tasks survive. No write occurs when nothing is removable.
   * Persistence failure leaves in-memory state unchanged.
   */
  async clearCompleted(): Promise<number[]> {
    const retained = new Set(
      [...this.tasks.values()]
        .filter((task) => task.status !== "completed")
        .map((task) => task.id),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...retained]) {
        const reviewer = this.tasks.get(id);
        if (reviewer === undefined || reviewer.status === "deleted") continue;
        for (const writerId of reviewer.reviewOf) {
          const writer = this.tasks.get(writerId);
          if (writer?.status !== "completed" || retained.has(writerId)) continue;
          retained.add(writerId);
          changed = true;
        }
      }
    }
    const removed = [...this.tasks.values()]
      .filter((task) => task.status === "completed" && !retained.has(task.id))
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
        reviewOf: task.reviewOf.filter((writerId) => !removedSet.has(writerId)),
        metadata: { ...task.metadata },
        log: cloneLog(task.log),
      });
    }
    validateDependencies(candidateTasks);
    checkReviewUniqueness(candidateTasks);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    // Empty-list reset mirrors clear-all timing: a fresh list starts from zero.
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

interface ValidatedCreateBatchItem {
  index: number;
  ref?: string;
  subject: string;
  description: string;
  assignee?: string;
  blockedBy: number[];
  blockedByRefs: string[];
  reviewOf: number[];
  reviewOfRefs: string[];
  metadata: Record<string, unknown>;
  maxAttempts: number;
}

const TASK_REF_PATTERN = /^[a-z][a-z0-9_-]*$/;

function assertValidTaskRef(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !TASK_REF_PATTERN.test(value)) {
    throw new TaskError(`${label} must match ^[a-z][a-z0-9_-]*$.`);
  }
}

function validateCreateBatchItem(
  input: TaskCreateBatchInput,
  configuredMaxAttempts: number,
  index: number,
): ValidatedCreateBatchItem {
  if (!isRecord(input)) throw new TaskError(`tasks[${index}] must be an object.`);
  assertNoPrefix(input);
  assertNoColor(input);
  if (input.ref !== undefined) assertValidTaskRef(input.ref, `tasks[${index}].ref`);
  if (typeof input.subject !== "string" || input.subject.trim().length === 0) {
    throw new TaskError("subject must be a non-empty string.");
  }
  if (typeof input.description !== "string") throw new TaskError("description must be a string.");
  if (input.assignee !== undefined && typeof input.assignee !== "string") {
    throw new TaskError("assignee must be a string.");
  }
  const blockedBy = input.blockedBy ?? [];
  assertIdList(blockedBy);
  const blockedByRefs = input.blockedByRefs ?? [];
  if (!Array.isArray(blockedByRefs)) throw new TaskError("blockedByRefs must be an array of task refs.");
  blockedByRefs.forEach((ref, refIndex) => assertValidTaskRef(ref, `tasks[${index}].blockedByRefs[${refIndex}]`));
  const reviewOf = input.reviewOf ?? [];
  assertIdList(reviewOf, "reviewOf");
  const reviewOfRefs = input.reviewOfRefs ?? [];
  if (!Array.isArray(reviewOfRefs)) throw new TaskError("reviewOfRefs must be an array of task refs.");
  reviewOfRefs.forEach((ref, refIndex) => assertValidTaskRef(ref, `tasks[${index}].reviewOfRefs[${refIndex}]`));
  const metadata = input.metadata ?? {};
  if (!isRecord(metadata)) throw new TaskError("metadata must be an object.");
  let maxAttempts: number;
  if (input.maxAttempts !== undefined) {
    assertValidMaxAttempts(input.maxAttempts);
    maxAttempts = input.maxAttempts;
  } else {
    assertValidConfigMaxAttempts(configuredMaxAttempts);
    maxAttempts = configuredMaxAttempts;
  }
  const validated: ValidatedCreateBatchItem = {
    index,
    subject: input.subject,
    description: input.description,
    blockedBy: [...blockedBy],
    blockedByRefs: [...blockedByRefs],
    reviewOf: [...reviewOf],
    reviewOfRefs: [...reviewOfRefs],
    metadata: { ...metadata },
    maxAttempts,
  };
  if (input.ref !== undefined) validated.ref = input.ref;
  if (input.assignee !== undefined) validated.assignee = input.assignee;
  return validated;
}

/** Stable Kahn sort: ready items are always selected by original input index. */
function stableTopologicalOrder(items: ValidatedCreateBatchItem[], refToIndex: Map<string, number>): number[] {
  const indegree = items.map(() => 0);
  const dependents = items.map(() => new Set<number>());
  for (const item of items) {
    const uniqueDependencies = new Set(
      [...item.blockedByRefs, ...item.reviewOfRefs].map((ref) => refToIndex.get(ref) as number),
    );
    indegree[item.index] = uniqueDependencies.size;
    for (const dependencyIndex of uniqueDependencies) dependents[dependencyIndex].add(item.index);
  }
  const ready = items.filter((item) => indegree[item.index] === 0).map((item) => item.index);
  const order: number[] = [];
  while (ready.length > 0) {
    const index = ready.shift() as number;
    order.push(index);
    for (const dependentIndex of [...dependents[index]].sort((a, b) => a - b)) {
      indegree[dependentIndex] -= 1;
      if (indegree[dependentIndex] === 0) {
        const insertion = ready.findIndex((readyIndex) => readyIndex > dependentIndex);
        if (insertion === -1) ready.push(dependentIndex);
        else ready.splice(insertion, 0, dependentIndex);
      }
    }
  }
  if (order.length !== items.length) throw new TaskError("Batch-local task refs contain a dependency cycle.");
  return order;
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    blockedBy: [...task.blockedBy],
    reviewOf: [...task.reviewOf],
    metadata: { ...task.metadata },
    log: cloneLog(task.log),
  };
}

function isArchivableStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "deleted";
}

function historyCycle(tasks: Map<number, Task>, totalActiveMs: number, archivedAt: string): TaskHistoryCycle {
  return {
    archivedAt,
    tasks: [...tasks.values()].sort((a, b) => a.id - b.id).map(cloneTask),
    totalActiveMs,
  };
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
      {
        ...task,
        blockedBy: [...task.blockedBy],
        reviewOf: [...task.reviewOf],
        metadata: { ...task.metadata },
        log: cloneLog(task.log),
      },
    ]),
  );
}

/** Ordered, de-duplicated prerequisites used for graph and execution checks. */
export function effectivePrereqs(task: Task): number[] {
  const prerequisites = task.status === "deleted" ? task.blockedBy : [...task.blockedBy, ...task.reviewOf];
  return [...new Set(prerequisites)];
}

/** Active direct reviewer of a writer, if one exists. */
export function reviewerFor(tasks: ReadonlyMap<number, Task> | readonly Task[], writerId: number): Task | undefined {
  const values = Array.isArray(tasks) ? tasks : [...tasks.values()];
  return values.find((task) => task.status !== "deleted" && task.reviewOf.includes(writerId));
}

/** Enforce one active reviewer per writer. */
export function checkReviewUniqueness(tasks: ReadonlyMap<number, Task>): void {
  const reviewerByWriter = new Map<number, number>();
  for (const reviewer of tasks.values()) {
    if (reviewer.status === "deleted") continue;
    for (const writerId of new Set(reviewer.reviewOf)) {
      const existing = reviewerByWriter.get(writerId);
      if (existing !== undefined && existing !== reviewer.id) {
        throw new TaskError(`Task #${writerId} is already reviewed by #${existing}.`);
      }
      reviewerByWriter.set(writerId, reviewer.id);
    }
  }
}

export type TransitionEligibility = { allowed: true } | { allowed: false; error: string };

/** Pure lifecycle eligibility checks in the store's established error order. */
export function transitionEligibility(
  current: Task,
  proposed: Task,
  proposedTasks: ReadonlyMap<number, Task>,
  appendLog?: string,
): TransitionEligibility {
  if (current.status === "deleted" && proposed.status !== "deleted") {
    return { allowed: false, error: `Task #${current.id} is deleted and cannot transition to another status.` };
  }
  if (current.status !== proposed.status) {
    if (!(ALLOWED_TRANSITIONS[current.status] as readonly TaskStatus[]).includes(proposed.status)) {
      return { allowed: false, error: `Task #${current.id} cannot transition from ${current.status} to ${proposed.status}.` };
    }
    if (appendLog === undefined || appendLog.trim().length === 0) {
      return { allowed: false, error: `Transition to ${proposed.status} requires a non-empty appendLog.` };
    }
  }
  if (proposed.status === "in_progress" && current.status !== "in_progress") {
    if (current.maxAttempts > 0 && current.attempt >= current.maxAttempts) {
      return {
        allowed: false,
        error: `Task #${current.id} has reached the maximum number of attempts (${current.maxAttempts}).`,
      };
    }
    if (current.attempt >= Number.MAX_SAFE_INTEGER) {
      return {
        allowed: false,
        error: `Task #${current.id} cannot enter in_progress: attempt counter has reached Number.MAX_SAFE_INTEGER.`,
      };
    }
  }
  const prerequisites = effectivePrereqs(proposed);
  for (const depId of prerequisites) {
    if (depId === proposed.id) {
      return { allowed: false, error: `Task #${proposed.id} cannot depend on itself.` };
    }
    if (!proposedTasks.has(depId)) {
      return { allowed: false, error: `Task #${depId} does not exist.` };
    }
  }
  if (proposed.status === "in_progress") {
    const open = prerequisites.filter((depId) => proposedTasks.get(depId)?.status !== "completed");
    if (open.length > 0) {
      return {
        allowed: false,
        error: `Task #${proposed.id} cannot remain in_progress: dependencies not completed: ${open.map((depId) => `#${depId}`).join(", ")}.`,
      };
    }
  }
  return { allowed: true };
}

function validateDependencies(tasks: Map<number, Task>): void {
  for (const task of tasks.values()) {
    const eligibility = transitionEligibility(task, task, tasks);
    if (!eligibility.allowed) throw new TaskError(eligibility.error);
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (id: number): void => {
    if (visiting.has(id)) throw new TaskError(`Task #${id} is part of a dependency cycle.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const depId of effectivePrereqs(tasks.get(id) as Task)) visit(depId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of tasks.keys()) visit(id);
}

function assertValidMaxAttempts(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new TaskError(`Invalid maxAttempts: ${String(value)}. Expected a positive safe integer.`);
  }
}

function assertValidConfigMaxAttempts(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new TaskError(`Invalid maxAttempts: ${String(value)}. Expected a non-negative safe integer (0 means unlimited).`);
  }
}

function assertValidId(id: number): void {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new TaskError(`Invalid task id: ${String(id)}. Expected a positive safe integer.`);
  }
}

function assertIdList(ids: number[], label = "blockedBy"): void {
  if (!Array.isArray(ids)) throw new TaskError(`${label} must be an array of task ids.`);
  for (const id of ids) assertValidId(id);
}

export interface TurnStartResult {
  store: TaskStore;
  /** Whether this turn start atomically archived a completed/deleted terminal task list. */
  cleaned: boolean;
}

/**
 * Turn-start lifecycle: load the session store, then atomically archive a
 * non-empty completed/deleted-only list before the next user turn renders its
 * widget. Active tasks and timing are cleared while history and `nextId` are
 * preserved; non-terminal and empty lists are left untouched.
 */
export async function turnStartStore(cwd: string, sessionId: string): Promise<TurnStartResult> {
  const store = await TaskStore.load(taskFilePath(cwd, sessionId));
  const cleaned = await store.archiveTerminalCycle();
  return { store, cleaned };
}
