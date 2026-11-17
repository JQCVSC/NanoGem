import fs from "fs/promises";
import { Bot, webhookCallback, type Context } from "grammy";
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_SYSTEM_INSTRUCTION,
  isConfiguredGeminiApiKey,
  runGeminiAgent,
  type AgentServiceDependencies,
} from "../../agent/agentService.ts";
import {
  buildProjectSystemInstruction,
  loadProjectInstructionsAndMemory,
} from "../../agent/projectContext.ts";
import { AgentProgressStream } from "../../agent/progressStream.ts";
import type { SandboxConfig } from "../../server/sandboxRuntime.ts";
import type { ProjectStore } from "../../storage/projectStore.ts";
import type { SessionStore } from "../../storage/sessionStore.ts";
import type { TelegramMappingStore } from "../../storage/telegramMappingStore.ts";
import {
  isTelegramAuthorized,
  redactTelegramSecrets,
  type TelegramConfig,
} from "./config.ts";
import {
  escapeTelegramHtml,
  extractTelegramPrompt,
  formatMarkdownForTelegramHtml,
  splitTelegramMessage,
} from "./formatting.ts";

export interface IncomingTelegramMessage {
  chatId: string;
  chatType: string;
  userId: string;
  text: string;
  botUsername?: string;
}

export interface TelegramReplySink {
  sendText(chatId: string, text: string, parseMode?: "HTML"): Promise<string | void>;
  editText?(
    chatId: string,
    messageId: string,
    text: string,
    parseMode?: "HTML"
  ): Promise<void>;
}

export interface TelegramAdapterDeps {
  config: TelegramConfig;
  sandboxConfig: SandboxConfig;
  projectStore: ProjectStore;
  sessionStore: SessionStore;
  mappingStore: TelegramMappingStore;
  agentDeps?: AgentServiceDependencies;
  geminiApiKey?: string;
}

export class TelegramChannelAdapter {
  private readonly config: TelegramConfig;
  private readonly sandboxConfig: SandboxConfig;
  private readonly projectStore: ProjectStore;
  private readonly sessionStore: SessionStore;
  private readonly mappingStore: TelegramMappingStore;
  private readonly agentDeps: AgentServiceDependencies;
  private readonly geminiApiKey?: string;
  private bot: Bot | null = null;
  private pollingActive = false;

  constructor(deps: TelegramAdapterDeps) {
    this.config = deps.config;
    this.sandboxConfig = deps.sandboxConfig;
    this.projectStore = deps.projectStore;
    this.sessionStore = deps.sessionStore;
    this.mappingStore = deps.mappingStore;
    this.agentDeps = deps.agentDeps || {};
    this.geminiApiKey = deps.geminiApiKey;
  }

  private async sendSafeFormatted(
    sink: TelegramReplySink,
    chatId: string,
    markdownText: string
  ): Promise<void> {
    const chunks = splitTelegramMessage(markdownText, 3800);
    for (const chunk of chunks) {
      const html = formatMarkdownForTelegramHtml(chunk);
      try {
        await sink.sendText(chatId, html, "HTML");
      } catch {
        await sink.sendText(chatId, chunk);
      }
    }
  }

  /**
   * Processes a single incoming Telegram message (used by polling, webhooks, and tests).
   */
  async handleIncomingMessage(
    msg: IncomingTelegramMessage,
    sink: TelegramReplySink
  ): Promise<{ handled: boolean; authorized: boolean; reply?: string }> {
    if (!isTelegramAuthorized(msg.userId, msg.chatId, this.config)) {
      await sink.sendText(
        msg.chatId,
        "Unauthorized: your Telegram user/chat ID is not in NanoGem's allowlist."
      );
      return { handled: true, authorized: false };
    }

    const rawText = msg.text.trim();
    if (!rawText) {
      return { handled: false, authorized: true };
    }

    // Handle slash commands (stripping optional @botUsername suffix like /status@MyBot)
    if (rawText.startsWith("/")) {
      const [rawCmd] = rawText.split(/\s+/, 1);
      const command = rawCmd.split("@")[0].toLowerCase();

      if (command === "/start") {
        const binding = this.mappingStore.ensureChatBinding(msg.chatId);
        const reply = [
          "<b>NanoGem Telegram Channel Ready</b>",
          `Project: <code>${escapeTelegramHtml(binding.project.id)}</code>`,
          `Session: <code>${escapeTelegramHtml(binding.session.id)}</code>`,
          `Execution Mode: <code>${escapeTelegramHtml(this.sandboxConfig.executionMode)}</code>`,
          "Send a message to run NanoGem in this chat's isolated workspace, or /help for commands.",
        ].join("\n");
        await sink.sendText(msg.chatId, reply, "HTML");
        return { handled: true, authorized: true, reply };
      }

      if (command === "/help") {
        const reply = [
          "<b>NanoGem Telegram Commands</b>",
          "/start - Initialize or inspect this chat's isolated project binding",
          "/help - Show available commands",
          "/new - Start a new session in this chat's project",
          "/reset - Clear this chat's isolated workspace and start a fresh session",
          "/status - Show active project, session, and sandbox status",
          "",
          this.config.requireMention
            ? "Note: In group chats, mention the bot (@username) before your prompt."
            : "Note: Group mention requirement is disabled.",
        ].join("\n");
        await sink.sendText(msg.chatId, reply, "HTML");
        return { handled: true, authorized: true, reply };
      }

      if (command === "/new") {
        const binding = this.mappingStore.startNewSessionForChat(msg.chatId);
        const reply = `Started new session <code>${escapeTelegramHtml(binding.session.id)}</code> in project <code>${escapeTelegramHtml(binding.project.id)}</code>.`;
        await sink.sendText(msg.chatId, reply, "HTML");
        return { handled: true, authorized: true, reply };
      }

      if (command === "/reset") {
        const binding = this.mappingStore.ensureChatBinding(msg.chatId);
        await fs.rm(binding.project.workspacePath, { recursive: true, force: true });
        await fs.mkdir(binding.project.workspacePath, { recursive: true });
        const fresh = this.mappingStore.startNewSessionForChat(
          msg.chatId,
          `Reset Session ${new Date().toISOString()}`
        );
        const reply = `Reset isolated workspace for project <code>${escapeTelegramHtml(fresh.project.id)}</code> and started session <code>${escapeTelegramHtml(fresh.session.id)}</code>.`;
        await sink.sendText(msg.chatId, reply, "HTML");
        return { handled: true, authorized: true, reply };
      }

      if (command === "/status") {
        const binding = this.mappingStore.ensureChatBinding(msg.chatId);
        const details = this.sessionStore.getSessionDetails(
          binding.session.id,
          binding.project.id
        );
        const reply = [
          "<b>NanoGem Status</b>",
          `Project: <code>${escapeTelegramHtml(binding.project.id)}</code>`,
          `Session: <code>${escapeTelegramHtml(binding.session.id)}</code>`,
          `Messages: <code>${details?.messages.length ?? 0}</code>`,
          `Execution Mode: <code>${escapeTelegramHtml(this.sandboxConfig.executionMode)}</code>`,
        ].join("\n");
        await sink.sendText(msg.chatId, reply, "HTML");
        return { handled: true, authorized: true, reply };
      }
    }

    const extracted = extractTelegramPrompt({
      text: rawText,
      chatType: msg.chatType,
      botUsername: msg.botUsername,
      requireMention: this.config.requireMention,
    });
    if (!extracted.accepted) {
      return { handled: false, authorized: true };
    }

    const activeKey = this.geminiApiKey ?? process.env.GEMINI_API_KEY;
    if (!this.agentDeps.client && !isConfiguredGeminiApiKey(activeKey)) {
      const reply = "GEMINI_API_KEY is not configured on the NanoGem host server.";
      await sink.sendText(msg.chatId, reply);
      return { handled: true, authorized: true, reply };
    }

    const binding = this.mappingStore.ensureChatBinding(msg.chatId);
    const details = this.sessionStore.getSessionDetails(
      binding.session.id,
      binding.project.id
    );
    const history = (details?.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    this.sessionStore.appendMessage({
      sessionId: binding.session.id,
      projectId: binding.project.id,
      role: "user",
      content: extracted.prompt,
    });

    const projectSandbox = this.projectStore.buildSandboxConfigForProject(
      this.sandboxConfig,
      binding.project.id
    );
    const projectCtx = await loadProjectInstructionsAndMemory(
      binding.project.workspacePath
    );
    const systemInstruction = buildProjectSystemInstruction({
      baseInstruction: DEFAULT_SYSTEM_INSTRUCTION,
      projectName: binding.project.name,
      geminiMd: projectCtx.geminiMd,
      memoryMd: projectCtx.memoryMd,
    });

    let statusMsgId: string | undefined;
    try {
      const sent = await sink.sendText(msg.chatId, "⏳ Analyzing request...");
      if (typeof sent === "string") statusMsgId = sent;
    } catch {
      // Ignore initial status failure
    }

    const progressStream = new AgentProgressStream();
    let lastProgressUpdateAt = 0;
    progressStream.subscribe(async (ev) => {
      if (ev.stage === "finished") return;
      const now = Date.now();
      if (now - lastProgressUpdateAt < 400 && ev.stage !== "error") return;
      lastProgressUpdateAt = now;
      const line = ev.detail ? `⏳ ${ev.label}: ${ev.detail}` : `⏳ ${ev.label}...`;
      const safeLine = redactTelegramSecrets(line, this.config.botToken);
      try {
        if (statusMsgId && sink.editText) {
          await sink.editText(msg.chatId, statusMsgId, safeLine);
        }
      } catch {
        // Ignore Telegram edit-rate or unchanged-text errors
      }
    });

    try {
      const result = await runGeminiAgent(
        {
          message: extracted.prompt,
          history,
          model: binding.session.model || DEFAULT_GEMINI_MODEL,
          systemInstruction,
          protectContextFiles: true,
          sandboxConfig: projectSandbox,
          onPhase: (phase, turn) => progressStream.handlePhase(phase, turn),
          onEvent: (event) => progressStream.handleAgentEvent(event),
        },
        {
          ...this.agentDeps,
          apiKey: this.agentDeps.apiKey ?? activeKey,
        }
      );

      this.sessionStore.appendMessage({
        sessionId: binding.session.id,
        projectId: binding.project.id,
        role: "assistant",
        content: result.text,
        executionSteps: result.executionSteps,
      });
      this.sessionStore.appendExecutionEvents(
        binding.session.id,
        binding.project.id,
        result.events
      );
      this.projectStore.touchProject(binding.project.id);

      const safeReply = redactTelegramSecrets(
        result.text || "Completed.",
        this.config.botToken
      );
      await this.sendSafeFormatted(sink, msg.chatId, safeReply);
      return { handled: true, authorized: true, reply: safeReply };
    } catch (error: any) {
      const safeErr = redactTelegramSecrets(
        error?.message || "Agent execution failed.",
        this.config.botToken
      );
      await sink.sendText(msg.chatId, `Error: ${safeErr}`);
      return { handled: true, authorized: true, reply: safeErr };
    }
  }

  private createBotInstance(): Bot {
    if (!this.config.enabled || !this.config.botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
    }
    if (this.bot) return this.bot;

    const bot = new Bot(this.config.botToken);
    const createSink = (ctx: Context): TelegramReplySink => ({
      sendText: async (chatId, text, parseMode) => {
        const sent = await ctx.api.sendMessage(chatId, text, {
          parse_mode: parseMode,
        });
        return String(sent.message_id);
      },
      editText: async (chatId, messageId, text, parseMode) => {
        await ctx.api.editMessageText(chatId, Number(messageId), text, {
          parse_mode: parseMode,
        });
      },
    });

    bot.on("message:text", async (ctx) => {
      const msg = ctx.message;
      await this.handleIncomingMessage(
        {
          chatId: String(msg.chat.id),
          chatType: msg.chat.type,
          userId: msg.from ? String(msg.from.id) : "",
          text: msg.text,
          botUsername: ctx.me?.username,
        },
        createSink(ctx)
      );
    });

    bot.catch((err) => {
      const safeMsg = redactTelegramSecrets(
        err?.message || String(err),
        this.config.botToken
      );
      console.error("[NanoGem Telegram] Bot error:", safeMsg);
    });

    this.bot = bot;
    return bot;
  }

  /**
   * Starts long polling when TELEGRAM_BOT_TOKEN and TELEGRAM_POLLING are enabled.
   */
  async startPolling(): Promise<boolean> {
    if (!this.config.enabled || !this.config.polling) {
      return false;
    }
    const bot = this.createBotInstance();
    if (this.pollingActive) return true;
    this.pollingActive = true;

    void bot.start({
      onStart: (botInfo) => {
        console.log(
          `[NanoGem Telegram] Long polling started as @${botInfo.username} (allowedUsers=${this.config.allowedUserIds.size})`
        );
      },
    });
    return true;
  }

  async stop(): Promise<void> {
    if (this.bot && this.pollingActive) {
      this.pollingActive = false;
      await this.bot.stop();
    }
  }

  /**
   * Future seam for HTTPS webhook mode (e.g. app.post("/api/telegram/webhook", adapter.createWebhookHandler())).
   */
  createWebhookHandler() {
    const bot = this.createBotInstance();
    return webhookCallback(bot, "express");
  }
}
