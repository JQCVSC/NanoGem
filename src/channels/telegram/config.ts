export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  allowedUserIds: Set<string>;
  allowedChatIds: Set<string>;
  requireMention: boolean;
  polling: boolean;
}

const PLACEHOLDER_TOKENS = new Set([
  "MY_TELEGRAM_BOT_TOKEN",
  "your_telegram_bot_token",
  "123456:ABC-DEF",
]);

function parseIdAllowlist(raw: string | undefined): Set<string> {
  const result = new Set<string>();
  if (!raw) return result;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (/^-?\d+$/.test(trimmed)) {
      result.add(trimmed);
    }
  }
  return result;
}

export function loadTelegramConfig(
  env: NodeJS.ProcessEnv = process.env
): TelegramConfig {
  const rawToken = env.TELEGRAM_BOT_TOKEN?.trim() || "";
  const tokenConfigured =
    Boolean(rawToken) && !PLACEHOLDER_TOKENS.has(rawToken);

  const allowedUserIds = parseIdAllowlist(env.TELEGRAM_ALLOWED_USER_IDS);
  const allowedChatIds = parseIdAllowlist(env.TELEGRAM_ALLOWED_CHAT_IDS);
  const requireMention =
    (env.TELEGRAM_REQUIRE_MENTION?.trim() ?? "true").toLowerCase() !== "false";
  const polling =
    (env.TELEGRAM_POLLING?.trim() ?? "true").toLowerCase() !== "false";

  return {
    enabled: tokenConfigured,
    botToken: tokenConfigured ? rawToken : "",
    allowedUserIds,
    allowedChatIds,
    requireMention,
    polling,
  };
}

/**
 * Fail-closed authorization check:
 * - TELEGRAM_ALLOWED_USER_IDS must be non-empty and contain userId.
 * - If TELEGRAM_ALLOWED_CHAT_IDS is non-empty, chatId must also be present.
 */
export function isTelegramAuthorized(
  userId: string | number | undefined,
  chatId: string | number | undefined,
  config: TelegramConfig
): boolean {
  if (userId === undefined || chatId === undefined) return false;
  if (config.allowedUserIds.size === 0) return false;

  const uid = String(userId).trim();
  const cid = String(chatId).trim();

  if (!config.allowedUserIds.has(uid)) return false;
  if (config.allowedChatIds.size > 0 && !config.allowedChatIds.has(cid)) {
    return false;
  }
  return true;
}

export function redactTelegramSecrets(text: string, botToken?: string): string {
  let clean = text;
  if (botToken && botToken.trim()) {
    clean = clean.split(botToken.trim()).join("[REDACTED_TELEGRAM_TOKEN]");
  }
  return clean.replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_TELEGRAM_TOKEN]");
}
