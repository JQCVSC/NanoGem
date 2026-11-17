import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_SYSTEM_INSTRUCTION,
  type AgentServiceDependencies,
} from "../agent/agentService.ts";
import { resolveAgentProvider, type AgentProvider } from "../agent/provider.ts";
import {
  buildProjectSystemInstruction,
  loadProjectInstructionsAndMemory,
} from "../agent/projectContext.ts";
import { AgentProgressStream } from "../agent/progressStream.ts";
import {
  isTelegramAuthorized,
  redactTelegramSecrets,
  type TelegramConfig,
} from "../channels/telegram/config.ts";
import type { SandboxConfig } from "../server/sandboxRuntime.ts";
import type { ProjectStore } from "../storage/projectStore.ts";
import type {
  ScheduledTaskKind,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  ScheduleStore,
} from "../storage/scheduleStore.ts";
import type { SessionStore } from "../storage/sessionStore.ts";
import type { TelegramMappingStore } from "../storage/telegramMappingStore.ts";

export interface SchedulerServiceDeps {
  enabledByEnv: boolean;
  sandboxConfig: SandboxConfig;
  projectStore: ProjectStore;
  sessionStore: SessionStore;
  scheduleStore: ScheduleStore;
  mappingStore?: TelegramMappingStore;
  telegramConfig?: TelegramConfig;
  sendTelegramMessage?: (chatId: string, text: string) => Promise<void>;
  agentProvider?: AgentProvider;
  agentDeps?: AgentServiceDependencies;
  geminiApiKey?: string;
  maxConcurrentGlobal?: number;
  pollIntervalMs?: number;
}

const TASK_PROMPTS: Record<ScheduledTaskKind, string> = {
  test_run:
    "Run the project's test suite inside /workspace using execute_system_command and report concise pass/fail results without modifying unrelated files.",
  repo_status:
    "Inspect /workspace files and repository status (e.g. git status --short if inside a git repo, or directory listing) and report a concise summary.",
  dependency_report:
    "Inspect package.json or requirements.txt in /workspace and report installed dependencies, missing lockfiles, or notable issues without installing untrusted packages over network.",
};

export function isSchedulingEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NANOGEM_SCHEDULES_ENABLED?.trim() ?? "false").toLowerCase() === "true";
}

export class SchedulerService {
  public readonly enabledByEnv: boolean;
  private readonly sandboxConfig: SandboxConfig;
  private readonly projectStore: ProjectStore;
  private readonly sessionStore: SessionStore;
  private readonly scheduleStore: ScheduleStore;
  private readonly mappingStore?: TelegramMappingStore;
  private readonly telegramConfig?: TelegramConfig;
  private readonly sendTelegramMessage?: (chatId: string, text: string) => Promise<void>;
  private readonly agentProvider: AgentProvider;
  private readonly maxConcurrentGlobal: number;
  private readonly pollIntervalMs: number;

  private readonly activeProjects = new Set<string>();
  private activeGlobalRuns = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SchedulerServiceDeps) {
    this.enabledByEnv = deps.enabledByEnv;
    this.sandboxConfig = deps.sandboxConfig;
    this.projectStore = deps.projectStore;
    this.sessionStore = deps.sessionStore;
    this.scheduleStore = deps.scheduleStore;
    this.mappingStore = deps.mappingStore;
    this.telegramConfig = deps.telegramConfig;
    this.sendTelegramMessage = deps.sendTelegramMessage;
    this.agentProvider =
      deps.agentProvider ??
      resolveAgentProvider(undefined, {
        ...(deps.agentDeps || {}),
        apiKey: deps.agentDeps?.apiKey ?? deps.geminiApiKey,
      });
    this.maxConcurrentGlobal = deps.maxConcurrentGlobal ?? 2;
    this.pollIntervalMs = deps.pollIntervalMs ?? 15_000;

    // Recover any tasks left 'running' before a crash/restart.
    this.scheduleStore.recoverInterruptedRuns();
  }

  start(): void {
    if (!this.enabledByEnv || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isProjectBusy(projectId: string): boolean {
    return this.activeProjects.has(projectId);
  }

  validateTelegramNotificationTarget(chatId: string | undefined | null): void {
    if (!chatId || !chatId.trim()) return;
    const trimmed = chatId.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error("notifyTelegramChatId must be a valid numeric Telegram chat ID.");
    }
    if (!this.telegramConfig?.enabled) {
      throw new Error(
        "Telegram notifications require TELEGRAM_BOT_TOKEN to be configured."
      );
    }
    if (
      this.telegramConfig.allowedChatIds.size > 0 &&
      !this.telegramConfig.allowedChatIds.has(trimmed)
    ) {
      throw new Error(
        `Security Error: Telegram chat "${trimmed}" is not in TELEGRAM_ALLOWED_CHAT_IDS.`
      );
    }
    if (
      this.telegramConfig.allowedChatIds.size === 0 &&
      !this.telegramConfig.allowedUserIds.has(trimmed) &&
      !this.mappingStore?.getMapping(trimmed)
    ) {
      throw new Error(
        `Security Error: Telegram chat "${trimmed}" is not an authorized DM/chat target.`
      );
    }
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (!this.enabledByEnv) return;
    const due = this.scheduleStore.listDueTasks(now);
    for (const task of due) {
      if (this.activeGlobalRuns >= this.maxConcurrentGlobal) break;
      if (this.activeProjects.has(task.projectId)) continue;
      await this.runTask(task.id);
    }
  }

  async runTask(taskId: string): Promise<ScheduledTaskRunRecord> {
    const task = this.scheduleStore.getTaskById(taskId);
    if (!task) {
      throw new Error(`Scheduled task "${taskId}" not found.`);
    }

    const project = this.projectStore.getProjectById(task.projectId);
    if (!project) {
      throw new Error(`Project "${task.projectId}" not found.`);
    }

    // Per-project concurrency lock & global concurrency ceiling
    if (this.activeProjects.has(task.projectId)) {
      throw new Error(
        `Concurrency Guard: Project "${task.projectId}" already has a scheduled task running.`
      );
    }
    if (this.activeGlobalRuns >= this.maxConcurrentGlobal) {
      throw new Error(
        `Concurrency Guard: Maximum concurrent scheduled runs (${this.maxConcurrentGlobal}) reached.`
      );
    }

    this.activeProjects.add(task.projectId);
    this.activeGlobalRuns++;

    const session = this.sessionStore.createSession({
      projectId: project.id,
      title: `[Scheduled] ${task.name}`,
      channel: "scheduler",
    });
    const runRecord = this.scheduleStore.recordRunStarted(task.id, project.id, session.id);

    try {
      if (!this.agentProvider.isConfigured()) {
        throw new Error(`${this.agentProvider.displayName} API key is not configured on the server.`);
      }

      const prompt = task.promptOverride || TASK_PROMPTS[task.taskKind];
      this.sessionStore.appendMessage({
        sessionId: session.id,
        projectId: project.id,
        role: "user",
        content: prompt,
      });

      const projectSandbox = this.projectStore.buildSandboxConfigForProject(
        this.sandboxConfig,
        project.id
      );
      const projectCtx = await loadProjectInstructionsAndMemory(project.workspacePath);
      const systemInstruction = buildProjectSystemInstruction({
        baseInstruction: DEFAULT_SYSTEM_INSTRUCTION,
        projectName: project.name,
        geminiMd: projectCtx.geminiMd,
        memoryMd: projectCtx.memoryMd,
      });

      const progressStream = new AgentProgressStream();
      const result = await this.agentProvider.run({
        message: prompt,
        model: DEFAULT_GEMINI_MODEL,
        systemInstruction,
        protectContextFiles: true,
        sandboxConfig: projectSandbox,
        onPhase: (phase, turn) => progressStream.handlePhase(phase, turn),
        onEvent: (event) => progressStream.handleAgentEvent(event),
      });

      this.sessionStore.appendMessage({
        sessionId: session.id,
        projectId: project.id,
        role: "assistant",
        content: result.text,
        executionSteps: result.executionSteps,
      });
      this.sessionStore.appendExecutionEvents(session.id, project.id, result.events);
      this.projectStore.touchProject(project.id);

      const finalStatus = result.maxTurnsReached ? "failed" : "succeeded";
      this.scheduleStore.recordRunFinished({
        runId: runRecord.id,
        taskId: task.id,
        status: finalStatus,
        output: result.text,
        error: result.maxTurnsReached ? result.text : undefined,
      });

      await this.notifyTelegram(task, finalStatus, result.text);
      return this.scheduleStore.getRunById(runRecord.id)!;
    } catch (error: any) {
      const errorMsg = redactTelegramSecrets(
        error?.message || "Scheduled task failed.",
        this.telegramConfig?.botToken
      );
      this.scheduleStore.recordRunFinished({
        runId: runRecord.id,
        taskId: task.id,
        status: "failed",
        error: errorMsg,
      });
      await this.notifyTelegram(task, "failed", errorMsg);
      return this.scheduleStore.getRunById(runRecord.id)!;
    } finally {
      this.activeProjects.delete(task.projectId);
      this.activeGlobalRuns = Math.max(0, this.activeGlobalRuns - 1);
    }
  }

  private async notifyTelegram(
    task: ScheduledTaskRecord,
    status: "succeeded" | "failed",
    summary: string
  ): Promise<void> {
    if (!task.notifyTelegramChatId || !this.sendTelegramMessage || !this.telegramConfig?.enabled) {
      return;
    }
    const chatId = task.notifyTelegramChatId;
    if (
      this.telegramConfig.allowedChatIds.size > 0 &&
      !this.telegramConfig.allowedChatIds.has(chatId)
    ) {
      return;
    }
    if (
      this.telegramConfig.allowedChatIds.size === 0 &&
      !isTelegramAuthorized(chatId, chatId, this.telegramConfig) &&
      !this.mappingStore?.getMapping(chatId)
    ) {
      return;
    }

    const safeSummary = redactTelegramSecrets(
      summary.slice(0, 1500),
      this.telegramConfig.botToken
    );
    const text = `[NanoGem Schedule: ${task.name}] Status: ${status.toUpperCase()}\nProject: ${task.projectId}\n\n${safeSummary}`;
    try {
      await this.sendTelegramMessage(chatId, text);
    } catch {
      // Notification failure should not erase persisted task status
    }
  }
}
