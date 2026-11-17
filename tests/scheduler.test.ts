import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { GeminiGenerateContentClient } from "../src/agent/agentService.ts";
import { loadTelegramConfig } from "../src/channels/telegram/config.ts";
import { loadSandboxConfig } from "../src/server/sandboxRuntime.ts";
import { openNanoGemDatabase } from "../src/storage/database.ts";
import { ProjectStore } from "../src/storage/projectStore.ts";
import { ScheduleStore } from "../src/storage/scheduleStore.ts";
import { SessionStore } from "../src/storage/sessionStore.ts";
import { computeNextRunAt, parseScheduleExpression } from "../src/scheduler/scheduleParser.ts";
import { isSchedulingEnabledByEnv, SchedulerService } from "../src/scheduler/schedulerService.ts";

test("Schedule parser validates interval and 5-field cron expressions and rejects invalid ones", () => {
  assert.equal(isSchedulingEnabledByEnv({}), false);
  assert.equal(isSchedulingEnabledByEnv({ NANOGEM_SCHEDULES_ENABLED: "true" }), true);

  const interval = parseScheduleExpression("15m");
  assert.equal(interval.kind, "interval");
  const cron = parseScheduleExpression("*/15 * * * 1-5");
  assert.equal(cron.kind, "cron");

  const next = computeNextRunAt("*/15 * * * *", new Date("2026-01-01T00:03:00.000Z"));
  assert.equal(next, "2026-01-01T00:15:00.000Z");

  assert.throws(() => parseScheduleExpression("5s"), /between 30s and 30d/);
  assert.throws(() => parseScheduleExpression("* * *"), /Invalid schedule/);
  assert.throws(() => parseScheduleExpression("99 * * * *"), /out of bounds/);
});

test("SchedulerService enforces opt-in defaults, pause/resume/delete, concurrency limits, Telegram notification auth, and restart recovery", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-scheduler-"));
  const dbPath = path.join(tmpRoot, "nanogem.db");
  const projectsRoot = path.join(tmpRoot, "projects");
  const defaultWs = path.join(tmpRoot, "default_ws");

  let db1: ReturnType<typeof openNanoGemDatabase> | null = null;
  let db2: ReturnType<typeof openNanoGemDatabase> | null = null;

  try {
    db1 = openNanoGemDatabase(dbPath);
    const projectStore1 = new ProjectStore(db1, projectsRoot);
    const sessionStore1 = new SessionStore(db1);
    const scheduleStore1 = new ScheduleStore(db1);
    const defProj = projectStore1.ensureDefaultProject(defaultWs);

    // 1. Disabled by default & bound strictly to an approved project
    assert.throws(
      () =>
        scheduleStore1.createTask({
          projectId: "nonexistent",
          name: "Bad",
          taskKind: "repo_status",
          scheduleExpr: "15m",
        }),
      /does not exist/
    );

    const task = scheduleStore1.createTask({
      projectId: defProj.id,
      name: "Repo Check",
      taskKind: "repo_status",
      scheduleExpr: "15m",
      enabled: false,
      notifyTelegramChatId: "42",
    });
    assert.equal(task.enabled, false);
    assert.equal(task.lastStatus, "paused");

    const resumed = scheduleStore1.resumeTask(task.id)!;
    assert.equal(resumed.enabled, true);
    assert.ok(resumed.nextRunAt);

    const paused = scheduleStore1.pauseTask(task.id)!;
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, null);

    // Simulate a run left 'running' before crash/restart
    const orphanRun = scheduleStore1.recordRunStarted(task.id, defProj.id, null);
    assert.equal(orphanRun.status, "running");
    db1.close();
    db1 = null;

    // 2. Restart recovery marks interrupted running tasks as failed
    db2 = openNanoGemDatabase(dbPath);
    const projectStore2 = new ProjectStore(db2, projectsRoot);
    const sessionStore2 = new SessionStore(db2);
    const scheduleStore2 = new ScheduleStore(db2);
    const tgConfig = loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345",
      TELEGRAM_ALLOWED_USER_IDS: "42",
      TELEGRAM_ALLOWED_CHAT_IDS: "42",
    });

    let resolveSlowTurn!: () => void;
    let slowTurnStarted = false;
    let calls = 0;
    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent() {
          calls++;
          if (calls === 1) {
            slowTurnStarted = true;
            await new Promise<void>((resolve) => {
              resolveSlowTurn = resolve;
            });
            return {
              text: "Repo status OK",
              candidates: [{ content: { role: "model", parts: [{ text: "Repo status OK" }] } }],
              functionCalls: [],
            };
          }
          throw new Error("Simulated failure");
        },
      },
    };

    const sentNotifications: Array<{ chatId: string; text: string }> = [];
    const scheduler = new SchedulerService({
      enabledByEnv: true,
      sandboxConfig: loadSandboxConfig(defaultWs, { NANOGEM_EXECUTION_MODE: "host" }),
      projectStore: projectStore2,
      sessionStore: sessionStore2,
      scheduleStore: scheduleStore2,
      telegramConfig: tgConfig,
      sendTelegramMessage: async (chatId, text) => {
        sentNotifications.push({ chatId, text });
      },
      agentDeps: { client: mockClient },
      geminiApiKey: "AIzaSyTestKey123456789012345",
    });

    const recoveredOrphan = scheduleStore2.getRunById(orphanRun.id)!;
    assert.equal(recoveredOrphan.status, "failed");
    assert.match(recoveredOrphan.error || "", /Interrupted by server restart/);

    // Reject unauthenticated Telegram notification chat IDs
    assert.throws(
      () => scheduler.validateTelegramNotificationTarget("999"),
      /Security Error/
    );

    // 3. Concurrency guard blocks parallel runs on the same project workspace
    const firstRunPromise = scheduler.runTask(task.id);
    while (!slowTurnStarted) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await assert.rejects(() => scheduler.runTask(task.id), /Concurrency Guard/);
    resolveSlowTurn();
    const firstRun = await firstRunPromise;
    assert.equal(firstRun.status, "succeeded");
    assert.equal(sentNotifications.length, 1);
    assert.equal(sentNotifications[0].chatId, "42");
    assert.match(sentNotifications[0].text, /SUCCEEDED/);

    // 4. Failures are persisted and visible
    const secondRun = await scheduler.runTask(task.id);
    assert.equal(secondRun.status, "failed");
    assert.match(secondRun.error || "", /Simulated failure/);
    assert.equal(scheduleStore2.getTaskById(task.id)?.lastStatus, "failed");

    // 5. Delete removes schedule
    assert.equal(scheduleStore2.deleteTask(task.id), true);
    assert.equal(scheduleStore2.getTaskById(task.id), null);

    db2.close();
    db2 = null;
  } finally {
    try { db1?.close(); } catch {}
    try { db2?.close(); } catch {}
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
