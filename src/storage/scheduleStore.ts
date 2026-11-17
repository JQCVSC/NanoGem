import crypto from "crypto";
import type { DatabaseSync } from "node:sqlite";
import { computeNextRunAt, parseScheduleExpression } from "../scheduler/scheduleParser.ts";

export type ScheduledTaskKind = "test_run" | "repo_status" | "dependency_report";
export type ScheduledTaskStatus = "idle" | "running" | "succeeded" | "failed" | "paused";
export type ScheduledRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ScheduledTaskRecord {
  id: string;
  projectId: string;
  name: string;
  taskKind: ScheduledTaskKind;
  scheduleExpr: string;
  promptOverride: string | null;
  enabled: boolean;
  notifyTelegramChatId: string | null;
  lastStatus: ScheduledTaskStatus;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  lastOutput: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskRunRecord {
  id: string;
  taskId: string;
  projectId: string;
  sessionId: string | null;
  status: ScheduledRunStatus;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface CreateScheduleInput {
  projectId: string;
  name: string;
  taskKind: ScheduledTaskKind;
  scheduleExpr: string;
  promptOverride?: string;
  enabled?: boolean;
  notifyTelegramChatId?: string | null;
}

function mapTaskRow(row: Record<string, unknown>): ScheduledTaskRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    taskKind: String(row.task_kind) as ScheduledTaskKind,
    scheduleExpr: String(row.schedule_expr),
    promptOverride: row.prompt_override ? String(row.prompt_override) : null,
    enabled: Number(row.enabled) === 1,
    notifyTelegramChatId: row.notify_telegram_chat_id
      ? String(row.notify_telegram_chat_id)
      : null,
    lastStatus: String(row.last_status) as ScheduledTaskStatus,
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    lastOutput: row.last_output ? String(row.last_output) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRunRow(row: Record<string, unknown>): ScheduledTaskRunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    projectId: String(row.project_id),
    sessionId: row.session_id ? String(row.session_id) : null,
    status: String(row.status) as ScheduledRunStatus,
    output: row.output ? String(row.output) : null,
    error: row.error ? String(row.error) : null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

export class ScheduleStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createTask(input: CreateScheduleInput): ScheduledTaskRecord {
    const projectExists = this.db
      .prepare("SELECT 1 FROM projects WHERE id = ?")
      .get(input.projectId);
    if (!projectExists) {
      throw new Error(`Project "${input.projectId}" does not exist.`);
    }

    const name = input.name?.trim();
    if (!name) {
      throw new Error("Task name is required.");
    }

    if (
      input.taskKind !== "test_run" &&
      input.taskKind !== "repo_status" &&
      input.taskKind !== "dependency_report"
    ) {
      throw new Error(`Unsupported taskKind "${input.taskKind}".`);
    }

    const parsed = parseScheduleExpression(input.scheduleExpr);
    const enabled = Boolean(input.enabled);
    const now = new Date();
    const nowIso = now.toISOString();
    const nextRunAt = enabled ? computeNextRunAt(parsed.raw, now) : null;
    const id = `sched_${crypto.randomUUID().slice(0, 12)}`;

    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (
           id, project_id, name, task_kind, schedule_expr, prompt_override,
           enabled, notify_telegram_chat_id, last_status, next_run_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        name,
        input.taskKind,
        parsed.raw,
        input.promptOverride?.trim() || null,
        enabled ? 1 : 0,
        input.notifyTelegramChatId?.trim() || null,
        enabled ? "idle" : "paused",
        nextRunAt,
        nowIso,
        nowIso
      );

    return this.getTaskById(id)!;
  }

  getTaskById(taskId: string): ScheduledTaskRecord | null {
    const row = this.db
      .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? mapTaskRow(row) : null;
  }

  listTasks(projectId?: string): ScheduledTaskRecord[] {
    const rows = projectId
      ? (this.db
          .prepare(
            "SELECT * FROM scheduled_tasks WHERE project_id = ? ORDER BY updated_at DESC"
          )
          .all(projectId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare("SELECT * FROM scheduled_tasks ORDER BY updated_at DESC")
          .all() as Array<Record<string, unknown>>);
    return rows.map(mapTaskRow);
  }

  listDueTasks(now: Date = new Date()): ScheduledTaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1
           AND last_status != 'running'
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
         ORDER BY next_run_at ASC`
      )
      .all(now.toISOString()) as Array<Record<string, unknown>>;
    return rows.map(mapTaskRow);
  }

  pauseTask(taskId: string): ScheduledTaskRecord | null {
    const existing = this.getTaskById(taskId);
    if (!existing) return null;
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET enabled = 0, last_status = CASE WHEN last_status = 'running' THEN 'running' ELSE 'paused' END,
             next_run_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(nowIso, taskId);
    return this.getTaskById(taskId);
  }

  resumeTask(taskId: string): ScheduledTaskRecord | null {
    const existing = this.getTaskById(taskId);
    if (!existing) return null;
    const now = new Date();
    const nextRunAt = computeNextRunAt(existing.scheduleExpr, now);
    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET enabled = 1,
             last_status = CASE WHEN last_status = 'paused' THEN 'idle' ELSE last_status END,
             next_run_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(nextRunAt, now.toISOString(), taskId);
    return this.getTaskById(taskId);
  }

  deleteTask(taskId: string): boolean {
    const res = this.db
      .prepare("DELETE FROM scheduled_tasks WHERE id = ?")
      .run(taskId);
    return Number(res.changes) > 0;
  }

  recordRunStarted(taskId: string, projectId: string, sessionId: string | null): ScheduledTaskRunRecord {
    const runId = `run_${crypto.randomUUID().slice(0, 12)}`;
    const nowIso = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `INSERT INTO scheduled_task_runs (id, task_id, project_id, session_id, status, started_at)
           VALUES (?, ?, ?, ?, 'running', ?)`
        )
        .run(runId, taskId, projectId, sessionId, nowIso);
      this.db
        .prepare(
          `UPDATE scheduled_tasks
           SET last_status = 'running', last_run_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(nowIso, nowIso, taskId);
      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
    return this.getRunById(runId)!;
  }

  recordRunFinished(input: {
    runId: string;
    taskId: string;
    status: "succeeded" | "failed" | "cancelled";
    output?: string;
    error?: string;
  }): void {
    const task = this.getTaskById(input.taskId);
    const now = new Date();
    const nowIso = now.toISOString();
    const nextRunAt =
      task && task.enabled ? computeNextRunAt(task.scheduleExpr, now) : null;
    const nextTaskStatus: ScheduledTaskStatus =
      input.status === "succeeded" ? "succeeded" : "failed";

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `UPDATE scheduled_task_runs
           SET status = ?, output = ?, error = ?, finished_at = ?
           WHERE id = ?`
        )
        .run(
          input.status,
          input.output ?? null,
          input.error ?? null,
          nowIso,
          input.runId
        );
      this.db
        .prepare(
          `UPDATE scheduled_tasks
           SET last_status = ?, next_run_at = ?, last_output = ?, last_error = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextTaskStatus,
          nextRunAt,
          input.output ?? null,
          input.error ?? null,
          nowIso,
          input.taskId
        );
      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  recoverInterruptedRuns(): number {
    const nowIso = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const res = this.db
        .prepare(
          `UPDATE scheduled_task_runs
           SET status = 'failed',
               error = COALESCE(error, 'Interrupted by server restart'),
               finished_at = ?
           WHERE status = 'running'`
        )
        .run(nowIso);

      this.db
        .prepare(
          `UPDATE scheduled_tasks
           SET last_status = 'failed',
               last_error = COALESCE(last_error, 'Interrupted by server restart'),
               updated_at = ?
           WHERE last_status = 'running'`
        )
        .run(nowIso);

      this.db.exec("COMMIT;");
      return Number(res.changes);
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  getRunById(runId: string): ScheduledTaskRunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM scheduled_task_runs WHERE id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ? mapRunRow(row) : null;
  }

  listRuns(projectId?: string, limit = 25): ScheduledTaskRunRecord[] {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT * FROM scheduled_task_runs
             WHERE project_id = ?
             ORDER BY started_at DESC
             LIMIT ?`
          )
          .all(projectId, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT * FROM scheduled_task_runs
             ORDER BY started_at DESC
             LIMIT ?`
          )
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map(mapRunRow);
  }
}
