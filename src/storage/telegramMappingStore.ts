import type { DatabaseSync } from "node:sqlite";
import type { ProjectRecord, ProjectStore } from "./projectStore.ts";
import type { SessionRecord, SessionStore } from "./sessionStore.ts";

export interface TelegramChatMapping {
  chatId: string;
  projectId: string;
  activeSessionId: string;
  createdAt: string;
  updatedAt: string;
}

function sanitizeChatIdForSlug(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^-+/, "neg_");
}

/**
 * Maintains explicit, isolated Telegram chat -> Project & Session bindings.
 * Never maps Telegram chats to the browser's "default" workspace implicitly.
 */
export class TelegramMappingStore {
  private readonly db: DatabaseSync;
  private readonly projectStore: ProjectStore;
  private readonly sessionStore: SessionStore;

  constructor(
    db: DatabaseSync,
    projectStore: ProjectStore,
    sessionStore: SessionStore
  ) {
    this.db = db;
    this.projectStore = projectStore;
    this.sessionStore = sessionStore;
  }

  getMapping(chatId: string): TelegramChatMapping | null {
    const row = this.db
      .prepare(
        `SELECT chat_id, project_id, active_session_id, created_at, updated_at
         FROM telegram_chat_mappings WHERE chat_id = ?`
      )
      .get(chatId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      chatId: String(row.chat_id),
      projectId: String(row.project_id),
      activeSessionId: String(row.active_session_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  ensureChatBinding(chatId: string): {
    mapping: TelegramChatMapping;
    project: ProjectRecord;
    session: SessionRecord;
  } {
    const existing = this.getMapping(chatId);
    if (existing) {
      const project = this.projectStore.getProjectById(existing.projectId);
      const session = this.sessionStore.getSession(existing.activeSessionId);
      if (project && session && session.projectId === project.id) {
        return { mapping: existing, project, session };
      }
    }

    const safeSlug = sanitizeChatIdForSlug(chatId);
    const project = this.projectStore.createProject({
      name: `Telegram Chat ${chatId}`,
      workspacePath: `telegram-${safeSlug}`,
    });
    const session = this.sessionStore.createSession({
      projectId: project.id,
      title: `Telegram Chat ${chatId}`,
      channel: "telegram",
      externalChatId: chatId,
    });

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO telegram_chat_mappings (chat_id, project_id, active_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           project_id = excluded.project_id,
           active_session_id = excluded.active_session_id,
           updated_at = excluded.updated_at`
      )
      .run(chatId, project.id, session.id, now, now);

    return {
      mapping: this.getMapping(chatId)!,
      project,
      session,
    };
  }

  startNewSessionForChat(chatId: string, title?: string): {
    mapping: TelegramChatMapping;
    project: ProjectRecord;
    session: SessionRecord;
  } {
    const { project } = this.ensureChatBinding(chatId);
    const session = this.sessionStore.createSession({
      projectId: project.id,
      title: title || `Telegram Session ${new Date().toISOString()}`,
      channel: "telegram",
      externalChatId: chatId,
    });
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE telegram_chat_mappings
         SET active_session_id = ?, updated_at = ?
         WHERE chat_id = ?`
      )
      .run(session.id, now, chatId);

    return {
      mapping: this.getMapping(chatId)!,
      project,
      session,
    };
  }
}
