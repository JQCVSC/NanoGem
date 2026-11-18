export const TRANSIENT_GEMINI_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
export const MAX_GEMINI_RETRIES = 2;
export const DEFAULT_GEMINI_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

export const GEMINI_TEMPORARILY_UNAVAILABLE_MESSAGE =
  "Gemini is temporarily unavailable because the selected model is under high demand. Please try again shortly.";

export interface StructuredAgentErrorPayload {
  error: string;
  code: string;
  retryable: boolean;
  status: number;
}

export interface GeminiErrorClassification {
  retryable: boolean;
  status: number;
  upstreamStatus?: number;
  code: string;
  message: string;
}

export interface GeminiRetryLogEntry {
  status: number;
  model: string;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  retryable: boolean;
  nextDelayMs?: number;
}

export interface GeminiRetryOptions {
  model: string;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: (entry: GeminiRetryLogEntry) => void;
}

function redactSecretLikeTokens(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[REDACTED_API_KEY]")
    .replace(/(GEMINI_API_KEY|NANOGEM_API_TOKEN|TELEGRAM_BOT_TOKEN)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

export class GeminiAgentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly model?: string;
  readonly upstreamStatus?: number;

  constructor(classification: GeminiErrorClassification, model?: string) {
    super(classification.message);
    this.name = "GeminiAgentError";
    this.status = classification.status;
    this.code = classification.code;
    this.retryable = classification.retryable;
    this.upstreamStatus = classification.upstreamStatus;
    this.model = model;
  }

  toPayload(): StructuredAgentErrorPayload {
    return {
      error: this.message,
      code: this.code,
      retryable: this.retryable,
      status: this.status,
    };
  }
}

interface ParsedUpstreamDetails {
  numericStatus?: number;
  grpcStatus?: string;
  rawMessage: string;
}

function parseUpstreamDetails(err: unknown): ParsedUpstreamDetails {
  const anyErr = err as any;
  const rawMessage =
    typeof anyErr?.message === "string"
      ? anyErr.message
      : typeof err === "string"
        ? err
        : String(err ?? "");

  let numericStatus: number | undefined;
  for (const candidate of [
    anyErr?.status,
    anyErr?.statusCode,
    anyErr?.code,
    anyErr?.error?.code,
    anyErr?.response?.status,
  ]) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
      numericStatus = candidate;
      break;
    }
  }

  let grpcStatus: string | undefined =
    typeof anyErr?.error?.status === "string" ? anyErr.error.status : undefined;

  if (rawMessage.includes("{")) {
    const start = rawMessage.indexOf("{");
    try {
      const parsed = JSON.parse(rawMessage.slice(start));
      const nested = parsed?.error ?? parsed;
      if (!numericStatus && typeof nested?.code === "number") {
        numericStatus = nested.code;
      }
      if (!grpcStatus && typeof nested?.status === "string") {
        grpcStatus = nested.status;
      }
    } catch {
      // Non-JSON or truncated message; fall back to pattern matching below.
    }
  }

  if (!numericStatus) {
    const httpMatch = rawMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
    if (httpMatch) {
      numericStatus = Number.parseInt(httpMatch[1], 10);
    }
  }

  if (!numericStatus && grpcStatus) {
    switch (grpcStatus.toUpperCase()) {
      case "UNAVAILABLE":
        numericStatus = 503;
        break;
      case "RESOURCE_EXHAUSTED":
        numericStatus = 429;
        break;
      case "INTERNAL":
        numericStatus = 500;
        break;
      case "DEADLINE_EXCEEDED":
        numericStatus = 504;
        break;
      case "UNAUTHENTICATED":
        numericStatus = 401;
        break;
      case "PERMISSION_DENIED":
        numericStatus = 403;
        break;
      case "NOT_FOUND":
        numericStatus = 404;
        break;
      case "INVALID_ARGUMENT":
        numericStatus = 400;
        break;
    }
  }

  return { numericStatus, grpcStatus, rawMessage };
}

/**
 * Classifies an error thrown by the Gemini API client as retryable transient unavailability
 * (429, 500, 502, 503, 504) or non-retryable configuration/request failure.
 */
export function classifyGeminiError(err: unknown, model?: string): GeminiErrorClassification {
  if (err instanceof GeminiAgentError) {
    return {
      retryable: err.retryable,
      status: err.status,
      upstreamStatus: err.upstreamStatus,
      code: err.code,
      message: err.message,
    };
  }

  const { numericStatus, grpcStatus, rawMessage } = parseUpstreamDetails(err);
  const grpcUpper = grpcStatus?.toUpperCase() || "";

  // Non-retryable authentication / API key failures
  if (
    numericStatus === 401 ||
    grpcUpper === "UNAUTHENTICATED" ||
    /API_KEY_INVALID|API key not valid|invalid api key|GEMINI_API_KEY is not configured/i.test(
      rawMessage
    )
  ) {
    return {
      retryable: false,
      status: 401,
      upstreamStatus: numericStatus,
      code: "GEMINI_INVALID_API_KEY",
      message:
        "Gemini API key is missing or invalid. Check GEMINI_API_KEY in server configuration and try again.",
    };
  }

  // Non-retryable permission / access failures
  if (
    numericStatus === 403 ||
    grpcUpper === "PERMISSION_DENIED" ||
    /PERMISSION_DENIED|permission denied/i.test(rawMessage)
  ) {
    return {
      retryable: false,
      status: 403,
      upstreamStatus: numericStatus,
      code: "GEMINI_PERMISSION_DENIED",
      message:
        "Gemini API access was denied. Check API key permissions and project enablement.",
    };
  }

  // Non-retryable invalid or unsupported model failures
  if (
    numericStatus === 404 ||
    grpcUpper === "NOT_FOUND" ||
    /models\/[^\s"']+ (is not found|was not found)|unknown model|invalid model|not supported for generateContent/i.test(
      rawMessage
    )
  ) {
    return {
      retryable: false,
      status: 400,
      upstreamStatus: numericStatus ?? 404,
      code: "GEMINI_INVALID_MODEL",
      message: model
        ? `The selected Gemini model "${model}" is not available or supported for this API configuration.`
        : "The selected Gemini model is not available or supported for this API configuration.",
    };
  }

  // Non-retryable malformed requests
  if (
    numericStatus === 400 ||
    grpcUpper === "INVALID_ARGUMENT" ||
    /INVALID_ARGUMENT|malformed request|Message is required|Invalid maxTurns/i.test(rawMessage)
  ) {
    return {
      retryable: false,
      status: 400,
      upstreamStatus: numericStatus ?? 400,
      code: "GEMINI_BAD_REQUEST",
      message: "Gemini rejected the request as malformed. Verify your prompt and configuration.",
    };
  }

  // Transient rate limit / upstream server unavailability (429, 500, 502, 503, 504)
  if (
    (numericStatus !== undefined && TRANSIENT_GEMINI_STATUS_CODES.has(numericStatus)) ||
    grpcUpper === "UNAVAILABLE" ||
    grpcUpper === "RESOURCE_EXHAUSTED" ||
    grpcUpper === "INTERNAL" ||
    grpcUpper === "DEADLINE_EXCEEDED" ||
    /experiencing high demand|temporarily unavailable/i.test(rawMessage)
  ) {
    const upstreamStatus = numericStatus ?? (grpcUpper === "RESOURCE_EXHAUSTED" ? 429 : 503);
    return {
      retryable: true,
      status: upstreamStatus === 429 ? 429 : 503,
      upstreamStatus,
      code: "GEMINI_TEMPORARILY_UNAVAILABLE",
      message: GEMINI_TEMPORARILY_UNAVAILABLE_MESSAGE,
    };
  }

  return {
    retryable: false,
    status: numericStatus && numericStatus >= 400 ? numericStatus : 500,
    upstreamStatus: numericStatus,
    code: "GEMINI_REQUEST_FAILED",
    message: redactSecretLikeTokens(rawMessage || "Gemini request failed."),
  };
}

export function defaultGeminiRetryLogger(entry: GeminiRetryLogEntry): void {
  const safeModel = redactSecretLikeTokens(entry.model || "unknown");
  const outcome =
    entry.nextDelayMs !== undefined
      ? `retrying_in=${entry.nextDelayMs}ms`
      : entry.retryable
        ? "retries_exhausted"
        : "non_retryable";
  console.warn(
    `[NanoGem Gemini] status=${entry.status} model=${safeModel} attempt=${entry.attempt}/${entry.maxAttempts} elapsed=${entry.elapsedMs}ms outcome=${outcome}`
  );
}

/**
 * Runs a Gemini API call with bounded exponential backoff retries (max 2 retries)
 * for transient HTTP 429/500/502/503/504 errors.
 */
export async function executeWithGeminiRetry<T>(
  operation: () => Promise<T>,
  options: GeminiRetryOptions
): Promise<T> {
  const rawDelays = options.retryDelaysMs ?? DEFAULT_GEMINI_RETRY_DELAYS_MS;
  const retryDelaysMs = rawDelays.slice(0, MAX_GEMINI_RETRIES);
  const maxAttempts = 1 + retryDelaysMs.length;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? defaultGeminiRetryLogger;

  const startedAt = now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const classification = classifyGeminiError(err, options.model);
      const elapsedMs = Math.max(0, now() - startedAt);
      const canRetry = classification.retryable && attempt < maxAttempts;
      const nextDelayMs = canRetry ? Math.max(0, retryDelaysMs[attempt - 1]) : undefined;

      logger({
        status: classification.upstreamStatus ?? classification.status,
        model: options.model,
        attempt,
        maxAttempts,
        elapsedMs,
        retryable: classification.retryable,
        nextDelayMs,
      });

      if (!canRetry) {
        throw new GeminiAgentError(classification, options.model);
      }

      await sleep(nextDelayMs!);
    }
  }

  throw new GeminiAgentError(
    {
      retryable: true,
      status: 503,
      code: "GEMINI_TEMPORARILY_UNAVAILABLE",
      message: GEMINI_TEMPORARILY_UNAVAILABLE_MESSAGE,
    },
    options.model
  );
}

export function toStructuredAgentErrorPayload(err: unknown): StructuredAgentErrorPayload {
  if (err instanceof GeminiAgentError) {
    return err.toPayload();
  }
  const anyErr = err as any;
  if (
    anyErr &&
    typeof anyErr === "object" &&
    typeof anyErr.statusCode === "number" &&
    typeof anyErr.code === "string"
  ) {
    return {
      error: redactSecretLikeTokens(String(anyErr.message || "Agent execution failed.")),
      code: anyErr.code,
      retryable: Boolean(anyErr.retryable),
      status: anyErr.statusCode,
    };
  }
  const classification = classifyGeminiError(err);
  return {
    error: classification.message,
    code: classification.code,
    retryable: classification.retryable,
    status: classification.status,
  };
}
