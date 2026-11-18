import type { AgentProgressEvent, ChatStatusStage, ExecutionStep } from "../types.ts";

export interface DiagnosticStatusInfo {
  stage: ChatStatusStage;
  label: string;
}

export interface StreamToolCallPayload {
  turn?: number;
  toolName: string;
  args?: Record<string, unknown>;
  timestamp?: string;
}

export interface StreamToolResultPayload {
  turn?: number;
  toolName: string;
  output: string;
  success?: boolean;
  timestamp?: string;
}

export interface StreamAssistantTextPayload {
  turn?: number;
  text?: string;
  delta?: string;
  timestamp?: string;
}

export interface ChatCompletionPayload {
  text: string;
  executionSteps?: ExecutionStep[];
  events?: unknown[];
  progressEvents?: AgentProgressEvent[];
  turns?: number;
  maxTurnsReached?: boolean;
  configuredModel?: string;
  modelUsed?: string;
  fallbackUsed?: boolean;
  files?: any[];
  projectId?: string;
  sessionId?: string;
}

export interface ChatStreamHandlers {
  onProgress?: (event: AgentProgressEvent) => void;
  onAssistantText?: (payload: StreamAssistantTextPayload) => void;
  onToolCall?: (payload: StreamToolCallPayload) => void;
  onToolResult?: (payload: StreamToolResultPayload) => void;
  onResult?: (payload: ChatCompletionPayload) => void;
  onDone?: () => void;
}

export class StreamFallbackEligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamFallbackEligibleError";
  }
}

export class StreamServerError extends Error {
  readonly code?: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(options: { message: string; code?: string; retryable?: boolean; status: number }) {
    super(options.message);
    this.name = "StreamServerError";
    this.code = options.code;
    this.retryable = Boolean(options.retryable);
    this.status = options.status;
  }
}

export class StreamProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly receivedAnyData: boolean;

  constructor(
    message: string,
    options: { code: string; retryable?: boolean; receivedAnyData?: boolean }
  ) {
    super(message);
    this.name = "StreamProtocolError";
    this.code = options.code;
    this.retryable = options.retryable ?? true;
    this.receivedAnyData = Boolean(options.receivedAnyData);
  }
}

export function mapProgressStageToDiagnostic(stage?: string): DiagnosticStatusInfo {
  switch (stage) {
    case "analyzing_request":
      return { stage: "analyzing_request", label: "Analyzing request" };
    case "calling_gemini":
      return { stage: "calling_gemini", label: "Calling Gemini" };
    case "running_command":
      return { stage: "running_command", label: "Running sandbox command" };
    case "command_completed":
      return { stage: "command_completed", label: "Running sandbox command" };
    case "command_failed":
      return { stage: "command_failed", label: "Running sandbox command" };
    case "reviewing_changes":
      return { stage: "reviewing_changes", label: "Reviewing changes" };
    case "finished":
    case "completed":
      return { stage: "completed", label: "Completed" };
    case "error":
    case "failed":
      return { stage: "failed", label: "Failed" };
    case "fallback":
      return { stage: "fallback", label: "Using standard JSON response" };
    default:
      return { stage: "calling_gemini", label: "Calling Gemini" };
  }
}

export async function parseHttpErrorResponse(res: Response): Promise<StreamServerError> {
  const errData = (await res.json().catch(() => ({}))) as Record<string, any>;
  return new StreamServerError({
    message:
      typeof errData.error === "string" && errData.error.trim()
        ? errData.error
        : `Request failed with status ${res.status}.`,
    code: typeof errData.code === "string" ? errData.code : undefined,
    retryable: Boolean(errData.retryable),
    status: typeof errData.status === "number" ? errData.status : res.status,
  });
}

export function isStreamingEndpointMissingStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/**
 * Parses a `/api/agent/chat/stream` Response (SSE or JSON compatibility response).
 * Normalizes line endings, flushes trailing SSE blocks after EOF, ignores `[DONE]`,
 * and avoids triggering duplicate fallback submits once stream data has started arriving.
 */
export async function consumeChatStreamResponse(
  res: Response,
  handlers: ChatStreamHandlers
): Promise<ChatCompletionPayload> {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();

  if (!contentType.includes("text/event-stream")) {
    if (contentType.includes("application/json")) {
      const jsonData = (await res.json()) as ChatCompletionPayload & Record<string, any>;
      if (typeof jsonData?.error === "string") {
        throw new StreamServerError({
          message: jsonData.error,
          code: typeof jsonData.code === "string" ? jsonData.code : undefined,
          retryable: Boolean(jsonData.retryable),
          status: typeof jsonData.status === "number" ? jsonData.status : res.status || 500,
        });
      }
      if (!jsonData || (typeof jsonData.text !== "string" && !Array.isArray(jsonData.executionSteps))) {
        throw new StreamFallbackEligibleError("Streaming endpoint returned an empty JSON response.");
      }
      handlers.onResult?.(jsonData);
      return jsonData;
    }

    throw new StreamFallbackEligibleError(
      `Streaming unavailable (unexpected content-type "${contentType || "none"}").`
    );
  }

  if (!res.body) {
    throw new StreamFallbackEligibleError("Streaming response body is unavailable.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalData: ChatCompletionPayload | null = null;
  let hasReceivedData = false;
  let sawDone = false;
  let accumulatedText = "";
  const accumulatedSteps: ExecutionStep[] = [];

  const processBlock = (rawBlock: string) => {
    const trimmedBlock = rawBlock.trim();
    if (!trimmedBlock) return;

    const lines = trimmedBlock.split("\n");
    let eventName = "message";
    const dataLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) return;

    const dataText = dataLines.join("\n").trim();
    if (!dataText) return;
    if (dataText === "[DONE]") {
      sawDone = true;
      handlers.onDone?.();
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      throw new StreamProtocolError("Received a malformed stream event from server.", {
        code: "MALFORMED_STREAM_EVENT",
        retryable: true,
        receivedAnyData: hasReceivedData,
      });
    }

    if (!parsed || typeof parsed !== "object") {
      throw new StreamProtocolError("Received a malformed stream event payload.", {
        code: "MALFORMED_STREAM_EVENT",
        retryable: true,
        receivedAnyData: hasReceivedData,
      });
    }

    hasReceivedData = true;

    if (eventName === "progress") {
      handlers.onProgress?.(parsed as AgentProgressEvent);
    } else if (eventName === "assistant_text") {
      const payload = parsed as StreamAssistantTextPayload;
      if (typeof payload.delta === "string") {
        accumulatedText += payload.delta;
      } else if (typeof payload.text === "string" && payload.text) {
        accumulatedText =
          accumulatedText && accumulatedText !== payload.text
            ? `${accumulatedText}\n\n${payload.text}`
            : payload.text;
      }
      handlers.onAssistantText?.(payload);
    } else if (eventName === "tool_call") {
      const payload = parsed as StreamToolCallPayload;
      accumulatedSteps.push({
        type: "tool_call",
        toolName: payload.toolName,
        args: payload.args,
      });
      handlers.onToolCall?.(payload);
    } else if (eventName === "tool_result") {
      const payload = parsed as StreamToolResultPayload;
      const pending = [...accumulatedSteps]
        .reverse()
        .find((s) => s.type === "tool_call" && s.toolName === payload.toolName && s.output === undefined);
      if (pending) {
        pending.output = payload.output;
      } else {
        accumulatedSteps.push({
          type: "tool_call",
          toolName: payload.toolName,
          output: payload.output,
        });
      }
      handlers.onToolResult?.(payload);
    } else if (eventName === "result") {
      finalData = parsed as ChatCompletionPayload;
      handlers.onResult?.(finalData);
    } else if (eventName === "error") {
      throw new StreamServerError({
        message: typeof parsed.error === "string" ? parsed.error : "Agent execution failed.",
        code: typeof parsed.code === "string" ? parsed.code : undefined,
        retryable: Boolean(parsed.retryable),
        status: typeof parsed.status === "number" ? parsed.status : 500,
      });
    } else if (eventName === "message" && typeof parsed.text === "string") {
      finalData = parsed as ChatCompletionPayload;
      handlers.onResult?.(finalData);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        processBlock(block);
        if (sawDone) break;
      }
      if (sawDone) break;
    }

    if (!sawDone) {
      buffer += decoder.decode().replace(/\r\n/g, "\n");
      if (buffer.trim()) {
        for (const trailing of buffer.split("\n\n")) {
          processBlock(trailing);
          if (sawDone) break;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore lock release errors
    }
  }

  if (finalData) {
    return finalData;
  }

  if (sawDone && (accumulatedText || accumulatedSteps.length > 0)) {
    const synthesized: ChatCompletionPayload = {
      text: accumulatedText || "NanoGem completed execution.",
      executionSteps: accumulatedSteps,
    };
    handlers.onResult?.(synthesized);
    return synthesized;
  }

  if (!hasReceivedData) {
    throw new StreamFallbackEligibleError("Stream ended before delivering any response events.");
  }

  throw new StreamProtocolError("Stream closed before returning a final response.", {
    code: "STREAM_CLOSED_INCOMPLETE",
    retryable: true,
    receivedAnyData: true,
  });
}
