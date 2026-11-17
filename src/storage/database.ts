import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_projects_sessions",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          workspace_path TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'browser',
          external_chat_id TEXT,
          model TEXT NOT NULL DEFAULT 'gemini-3.6-flash',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
          ON sessions(project_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          execution_steps_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session_created
          ON messages(session_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS execution_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          turn INTEGER NOT NULL DEFAULT 0,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_events_session_id
          ON execution_events(session_id, id ASC);
      `);
    },
  },
  {
    version: 2,
    name: "telegram_chat_mappings",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS telegram_chat_mappings (
          chat_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          active_session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (active_session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 3,
    name: "scheduled_tasks",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          task_kind TEXT NOT NULL CHECK(task_kind IN ('test_run', 'repo_status', 'dependency_report')),
          schedule_expr TEXT NOT NULL,
          prompt_override TEXT,
          enabled INTEGER NOT NULL DEFAULT 0,
          notify_telegram_chat_id TEXT,
          last_status TEXT NOT NULL DEFAULT 'idle',
          last_run_at TEXT,
          next_run_at TEXT,
          last_error TEXT,
          last_output TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project
          ON scheduled_tasks(project_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS scheduled_task_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          session_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'cancelled')),
          output TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_scheduled_runs_task
          ON scheduled_task_runs(task_id, started_at DESC);
      `);
    },
  },
];

/**
 * Opens a SQLite database at dbPath (creating parent directories when file-backed)
 * and runs any pending schema migrations inside transactions.
 */
export function openNanoGemDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE;");
    try {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  return db;
}
