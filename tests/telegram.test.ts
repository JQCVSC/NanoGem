import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { GeminiGenerateContentClient } from "../src/agent/agentService.ts";
import { loadSandboxConfig, executeSandboxCommand } from "../src/server/sandboxRuntime.ts";
import { openNanoGemDatabase } from "../src/storage/database.ts";
import { ProjectStore } from "../src/storage/projectStore.ts";
import { SessionStore } from "../src/storage/sessionStore.ts";
import { TelegramMappingStore } from "../src/storage/telegramMappingStore.ts";
import {
  isTelegramAuthorized,
  loadTelegramConfig,
  redactTelegramSecrets,
} from "../src/channels/telegram/config.ts";
import {
  extractTelegramPrompt,
  formatMarkdownForTelegramHtml,
  splitTelegramMessage,
} from "../src/channels/telegram/formatting.ts";
import {
  TelegramChannelAdapter,
  type TelegramReplySink,
} from "../src/channels/telegram/telegramAdapter.ts";

test("Telegram authorization fails closed when allowlist is empty or user/chat is unauthorized", () => {
  const emptyCfg = loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345" });
  assert.equal(emptyCfg.enabled, true);
  assert.equal(isTelegramAuthorized("111", "111", emptyCfg), false);

  const userOnlyCfg = loadTelegramConfig({
    TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345",
    TELEGRAM_ALLOWED_USER_IDS: "111, 222",
    TELEGRAM_ALLOWED_CHAT_IDS: "",
  });
  assert.equal(isTelegramAuthorized("111", "999", userOnlyCfg), true);
  assert.equal(isTelegramAuthorized("333", "999", userOnlyCfg), false);

  const strictCfg = loadTelegramConfig({
    TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345",
    TELEGRAM_ALLOWED_USER_IDS: "111",
    TELEGRAM_ALLOWED_CHAT_IDS: "-100555",
  });
  assert.equal(isTelegramAuthorized("111", "-100555", strictCfg), true);
  assert.equal(isTelegramAuthorized("111", "111", strictCfg), false);
});

test("Telegram formatting, splitting, mention extraction, and token redaction work safely", () => {
  const longCode = "```ts\n" + "const x = 1;\n".repeat(400) + "```";
  const parts = splitTelegramMessage(longCode, 1000);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 1000);
    const fenceCount = (part.match(/```/g) || []).length;
    assert.equal(fenceCount % 2, 0);
  }

  const html = formatMarkdownForTelegramHtml("Check `my_file_name.ts` & **bold** <tag>");
  assert.match(html, /<code>my_file_name\.ts<\/code>/);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /&lt;tag&gt;/);

  const groupIgnored = extractTelegramPrompt({
    text: "hello bot",
    chatType: "supergroup",
    botUsername: "NanoGemBot",
    requireMention: true,
  });
  assert.equal(groupIgnored.accepted, false);

  const groupMentioned = extractTelegramPrompt({
    text: "@NanoGemBot inspect files",
    chatType: "supergroup",
    botUsername: "NanoGemBot",
    requireMention: true,
  });
  assert.equal(groupMentioned.accepted, true);
  assert.equal(groupMentioned.prompt, "inspect files");

  const token = "987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345";
  const redacted = redactTelegramSecrets(`Failed request with ${token}`, token);
  assert.equal(redacted.includes(token), false);
  assert.match(redacted, /\[REDACTED_TELEGRAM_TOKEN\]/);
});

test("TelegramChannelAdapter isolates chats from browser workspace, blocks unauthorized users, handles commands, and streams progress", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-telegram-"));
  const dbPath = path.join(tmpRoot, "nanogem.db");
  const projectsRoot = path.join(tmpRoot, "projects");
  const browserWs = path.join(tmpRoot, "browser_default_ws");

  try {
    const db = openNanoGemDatabase(dbPath);
    const projectStore = new ProjectStore(db, projectsRoot);
    const sessionStore = new SessionStore(db);
    projectStore.ensureDefaultProject(browserWs);
    const mappingStore = new TelegramMappingStore(db, projectStore, sessionStore);

    const sandboxConfig = loadSandboxConfig(browserWs, { NANOGEM_EXECUTION_MODE: "host" });
    const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ99999";
    const tgConfig = loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_ALLOWED_USER_IDS: "42",
      TELEGRAM_ALLOWED_CHAT_IDS: "",
      TELEGRAM_REQUIRE_MENTION: "true",
    });

    let geminiCalls = 0;
    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent() {
          geminiCalls++;
          if (geminiCalls === 1) {
            return {
              candidates: [{ content: { role: "model", parts: [] } }],
              functionCalls: [
                {
                  name: "write_local_file",
                  args: { file_path: "tg_note.txt", content: "telegram-only" },
                },
              ],
            };
          }
          if (geminiCalls === 2) {
            return {
              text: "Wrote `tg_note.txt` successfully.",
              candidates: [{ content: { role: "model", parts: [{ text: "Wrote `tg_note.txt` successfully." }] } }],
              functionCalls: [],
            };
          }
          throw new Error(`Upstream error leaking ${botToken}`);
        },
      },
    };

    const adapter = new TelegramChannelAdapter({
      config: tgConfig,
      sandboxConfig,
      projectStore,
      sessionStore,
      mappingStore,
      agentDeps: { client: mockClient },
      geminiApiKey: "AIzaSyTestKey123456789012345",
    });

    const sentMessages: Array<{ chatId: string; text: string; parseMode?: string }> = [];
    const editedMessages: Array<{ chatId: string; messageId: string; text: string }> = [];
    let nextId = 1;
    const sink: TelegramReplySink = {
      async sendText(chatId, text, parseMode) {
        sentMessages.push({ chatId, text, parseMode });
        return String(nextId++);
      },
      async editText(chatId, messageId, text) {
        editedMessages.push({ chatId, messageId, text });
      },
    };

    // 1. Unauthorized user never reaches Gemini
    const unauth = await adapter.handleIncomingMessage(
      { chatId: "999", chatType: "private", userId: "999", text: "hack" },
      sink
    );
    assert.equal(unauth.authorized, false);
    assert.equal(geminiCalls, 0);

    // 2. /start binds chat to its own isolated project (NOT browser default)
    await adapter.handleIncomingMessage(
      { chatId: "7001", chatType: "private", userId: "42", text: "/start" },
      sink
    );
    const binding = mappingStore.getMapping("7001");
    assert.ok(binding);
    assert.notEqual(binding.projectId, "default");

    // 3. /help & /status
    await adapter.handleIncomingMessage(
      { chatId: "7001", chatType: "private", userId: "42", text: "/help" },
      sink
    );
    await adapter.handleIncomingMessage(
      { chatId: "7001", chatType: "private", userId: "42", text: "/status" },
      sink
    );

    // 4. Authorized prompt executes via shared agentService inside Telegram's isolated workspace
    await adapter.handleIncomingMessage(
      { chatId: "7001", chatType: "private", userId: "42", text: "Create tg_note.txt" },
      sink
    );
    assert.equal(geminiCalls, 2);
    const tgProj = projectStore.getProjectById(binding.projectId)!;
    assert.equal(await fs.readFile(path.join(tgProj.workspacePath, "tg_note.txt"), "utf8"), "telegram-only");
    await assert.rejects(fs.access(path.join(browserWs, "tg_note.txt")));
    assert.ok(sentMessages.some((m) => m.text.includes("<code>tg_note.txt</code>")));

    // 5. /new starts a fresh session in the same Telegram project
    const oldSessionId = binding.activeSessionId;
    await adapter.handleIncomingMessage(
      { chatId: "7001", chatType: "private", userId: "42", text: "/new" },
      sink
    );
    const afterNew = mappingStore.getMapping("7001")!;
    assert.notEqual(afterNew.activeSessionId, oldSessionId);

    // 6. Errors redact TELEGRAM_BOT_TOKEN before replying
    await adapter.handleIncomingMessage(
      { chatId: "7001", chatType: "private", userId: "42", text: "Trigger error" },
      sink
    );
    assert.equal(
      sentMessages.some((m) => m.text.includes(botToken)),
      false
    );
    assert.ok(
      sentMessages.some((m) => m.text.includes("[REDACTED_TELEGRAM_TOKEN]"))
    );

    // 7. /reset clears only Telegram chat workspace
    await adapter.handleIncomingMessage(
      { chatId: "7001", chatType: "private", userId: "42", text: "/reset" },
      sink
    );
    await assert.rejects(fs.access(path.join(tgProj.workspacePath, "tg_note.txt")));

    // 8. Verify TELEGRAM_BOT_TOKEN is stripped from sandbox execution environment
    const prevTgToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = botToken;
    try {
      const envOut = await executeSandboxCommand(
        'node -e "console.log(process.env.TELEGRAM_BOT_TOKEN || \'STRIPPED\')"',
        sandboxConfig
      );
      assert.equal(envOut.trim(), "STRIPPED");
    } finally {
      if (prevTgToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prevTgToken;
    }

    db.close();
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
