const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Converts common Markdown (fenced code blocks, inline code, bold) into
 * Telegram-safe HTML so underscores in file paths or identifiers never break entity parsing.
 */
export function formatMarkdownForTelegramHtml(markdown: string): string {
  const segments: string[] = [];
  const fenceRegex = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const formatInline = (plain: string): string => {
    const inlineParts = plain.split(/(`[^`\n]+`)/g);
    return inlineParts
      .map((part) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
          return `<code>${escapeTelegramHtml(part.slice(1, -1))}</code>`;
        }
        const escaped = escapeTelegramHtml(part);
        return escaped.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
      })
      .join("");
  };

  while ((match = fenceRegex.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      segments.push(formatInline(markdown.slice(lastIndex, match.index)));
    }
    const code = escapeTelegramHtml(match[2].replace(/\n$/, ""));
    segments.push(`<pre><code>${code}</code></pre>`);
    lastIndex = fenceRegex.lastIndex;
  }

  if (lastIndex < markdown.length) {
    segments.push(formatInline(markdown.slice(lastIndex)));
  }

  return segments.join("");
}

/**
 * Splits a plain or Markdown response into Telegram-sized chunks (<= maxLength),
 * preserving fenced code block boundaries across splits.
 */
export function splitTelegramMessage(
  text: string,
  maxLength = 3800
): string[] {
  const limit = Math.min(Math.max(maxLength, 200), TELEGRAM_MAX_MESSAGE_LENGTH);
  const normalized = text.trim();
  if (!normalized) return ["(Empty response)"];
  if (normalized.length <= limit) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  let openFenceLang: string | null = null;

  while (remaining.length > 0) {
    const prefix = openFenceLang !== null ? `\`\`\`${openFenceLang}\n` : "";
    const budget = limit - prefix.length - 8; // reserve space for closing fence if needed

    if (prefix.length + remaining.length <= limit) {
      chunks.push(prefix + remaining);
      break;
    }

    let cut = remaining.lastIndexOf("\n", budget);
    if (cut < Math.floor(budget * 0.4)) {
      cut = remaining.lastIndexOf(" ", budget);
    }
    if (cut <= 0) {
      cut = budget;
    }

    let piece = remaining.slice(0, cut).trimEnd();
    remaining = remaining.slice(cut).trimStart();

    const fullChunk = prefix + piece;
    const fenceMatches = fullChunk.match(/```[a-zA-Z0-9_-]*/g) || [];
    if (fenceMatches.length % 2 === 1) {
      // Currently inside an unclosed fence; find the opening lang tag.
      const lastFenceIdx = fullChunk.lastIndexOf("```");
      const lineEnd = fullChunk.indexOf("\n", lastFenceIdx);
      const header =
        lineEnd !== -1
          ? fullChunk.slice(lastFenceIdx + 3, lineEnd).trim()
          : "";
      openFenceLang = header;
      chunks.push(`${fullChunk}\n\`\`\``);
    } else {
      openFenceLang = null;
      chunks.push(fullChunk);
    }
  }

  return chunks;
}

/**
 * Validates group mention requirement and strips leading @botUsername mentions.
 */
export function extractTelegramPrompt(input: {
  text: string;
  chatType: string;
  botUsername?: string;
  requireMention: boolean;
}): { accepted: boolean; prompt: string } {
  const trimmed = input.text.trim();
  if (!trimmed) return { accepted: false, prompt: "" };

  const isGroup = input.chatType === "group" || input.chatType === "supergroup";
  if (!isGroup || !input.requireMention) {
    return { accepted: true, prompt: trimmed };
  }

  const username = input.botUsername?.trim().replace(/^@/, "");
  if (!username) {
    return { accepted: false, prompt: "" };
  }

  const mentionRegex = new RegExp(`@${username}\\b`, "i");
  if (!mentionRegex.test(trimmed)) {
    return { accepted: false, prompt: "" };
  }

  const stripped = trimmed.replace(new RegExp(`@${username}\\b`, "gi"), "").trim();
  return { accepted: Boolean(stripped), prompt: stripped };
}
