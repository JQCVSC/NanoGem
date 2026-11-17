import crypto from "crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_GEMINI_MODEL,
  type AgentEvent,
  type AgentExecutionStep,
} from "../agent/agentService.ts";

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  channel: string;
  externalChatId: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessageRecord {
  id: string;
  sessionId: string;
  projectId: string;
  role: "user" | "assistant";
  content: string;
  executionSteps: AgentExecutionStep[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredExecutionEventRecord {
  id: number;
  sessionId: string;
  projectId: string;
  turn: number;
  eventType: AgentEvent["type"];
  payload: AgentEvent;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetails {
  session: SessionRecord;
  messages: StoredMessageRecord[];
  events: StoredExecutionEventRecord[];
}

export interface CreateSessionInput {
  projectId: string;
  title?: string;
  channel?: string;
  externalChatId?: string | null;
  model?: string;
}

function mapSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    channel: String(row.channel),
    externalChatId: row.external_chat_id ? String(row.external_chat_id) : null,
    model: String(row.model),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMessageRow(row: Record<string, unknown>): StoredMessageRecord {
  let executionSteps: AgentExecutionStep[] = [];
  if (typeof row.execution_steps_json === "string" && row.execution_steps_json) {
    try {
      const parsed = JSON.parse(row.execution_steps_json);
      if (Array.isArray(parsed)) executionSteps = parsed;
    } catch {
      executionSteps = [];
    }
  }
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    projectId: String(row.project_id),
    role: row.role === "user" ? "user" : "assistant",
    content: String(row.content),
    executionSteps,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEventRow(row: Record<string, unknown>): StoredExecutionEventRecord {
  const payload = JSON.parse(String(row.payload_json)) as AgentEvent;
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    projectId: String(row.project_id),
    turn: Number(row.turn),
    eventType: String(row.event_type) as AgentEvent["type"],
    payload,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private assertProjectExists(projectId: string): void {
    const exists = this.db
      .prepare("SELECT 1 FROM projects WHERE id = ?")
      .get(projectId);
    if (!exists) {
      throw new Error(`Project "${projectId}" does not exist.`);
    }
  }

  private assertSessionOwnership(sessionId: string, projectId: string): SessionRecord {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }
    if (session.projectId !== projectId) {
      throw new Error(
        `Security Error: Session "${sessionId}" belongs to project "${session.projectId}", not "${projectId}".`
      );
    }
    return session;
  }

  createSession(input: CreateSessionInput): SessionRecord {
    this.assertProjectExists(input.projectId);
    const id = `sess_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const title = input.title?.trim() || "New Session";
    const channel = input.channel?.trim() || "browser";
    const model = input.model?.trim() || DEFAULT_GEMINI_MODEL;

    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, title, channel, external_chat_id, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        title,
        channel,
        input.externalChatId ?? null,
        model,
        now,
        now
      );

    return this.getSession(id)!;
  }

  listSessions(projectId?: string): SessionRecord[] {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT id, project_id, title, channel, external_chat_id, model, created_at, updated_at
             FROM sessions
             WHERE project_id = ?
             ORDER BY updated_at DESC, created_at DESC`
          )
          .all(projectId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, project_id, title, channel, external_chat_id, model, created_at, updated_at
             FROM sessions
             ORDER BY updated_at DESC, created_at DESC`
          )
          .all() as Array<Record<string, unknown>>);
    return rows.map(mapSessionRow);
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, title, channel, external_chat_id, model, created_at, updated_at
         FROM sessions WHERE id = ?`
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapSessionRow(row) : null;
  }

  ensureDefaultSession(projectId: string): SessionRecord {
    const existing = this.listSessions(projectId).find((s) => s.channel === "browser");
    if (existing) return existing;
    return this.createSession({
      projectId,
      title: "Default Session",
      channel: "browser",
    });
  }

  getSessionDetails(sessionId: string, expectedProjectId?: string): SessionDetails | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if (expectedProjectId && session.projectId !== expectedProjectId) {
      throw new Error(
        `Security Error: Session "${sessionId}" does not belong to project "${expectedProjectId}".`
      );
    }

    const messageRows = this.db
      .prepare(
        `SELECT id, session_id, project_id, role, content, execution_steps_json, created_at, updated_at
         FROM messages
         WHERE session_id = ? AND project_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(session.id, session.projectId) as Array<Record<string, unknown>>;

    const eventRows = this.db
      .prepare(
        `SELECT id, session_id, project_id, turn, event_type, payload_json, created_at, updated_at
         FROM execution_events
         WHERE session_id = ? AND project_id = ?
         ORDER BY id ASC`
      )
      .all(session.id, session.projectId) as Array<Record<string, unknown>>;

    return {
      session,
      messages: messageRows.map(mapMessageRow),
      events: eventRows.map(mapEventRow),
    };
  }

  appendMessage(input: {
    sessionId: string;
    projectId: string;
    role: "user" | "assistant";
    content: string;
    executionSteps?: AgentExecutionStep[];
  }): StoredMessageRecord {
    this.assertSessionOwnership(input.sessionId, input.projectId);
    const id = `msg_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const stepsJson = input.executionSteps ? JSON.stringify(input.executionSteps) : null;

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `INSERT INTO messages (id, session_id, project_id, role, content, execution_steps_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.sessionId,
          input.projectId,
          input.role,
          input.content,
          stepsJson,
          now,
          now
        );

      this.db
        .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(now, input.sessionId);

      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    const row = this.db
      .prepare(
        `SELECT id, session_id, project_id, role, content, execution_steps_json, created_at, updated_at
         FROM messages WHERE id = ?`
      )
      .get(id) as Record<string, unknown>;
    return mapMessageRow(row);
  }

  appendExecutionEvents(
    sessionId: string,
    projectId: string,
    events: AgentEvent[]
  ): StoredExecutionEventRecord[] {
    if (events.length === 0) return [];
    this.assertSessionOwnership(sessionId, projectId);
    const now = new Date().toISOString();
    const insertedIds: number[] = [];

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const insertStmt = this.db.prepare(
        `INSERT INTO execution_events (session_id, project_id, turn, event_type, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const event of events) {
        const res = insertStmt.run(
          sessionId,
          projectId,
          event.turn ?? 0,
          event.type,
          JSON.stringify(event),
          event.timestamp || now,
          now
        );
        insertedIds.push(Number(res.lastInsertRowid));
      }
      this.db
        .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(now, sessionId);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    const rows = insertedIds.map(
      (id) =>
        this.db
          .prepare(
            `SELECT id, session_id, project_id, turn, event_type, payload_json, created_at, updated_at
             FROM execution_events WHERE id = ?`
          )
          .get(id) as Record<string, unknown>
    );
    return rows.map(mapEventRow);
  }
}
