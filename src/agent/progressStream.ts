import crypto from "crypto";
import type { AgentEvent } from "./agentService.ts";

export type ProgressStage =
  | "analyzing_request"
  | "calling_gemini"
  | "running_command"
  | "command_completed"
  | "command_failed"
  | "reviewing_changes"
  | "finished"
  | "error";

export interface ProgressEvent {
  id: string;
  stage: ProgressStage;
  label: string;
  detail?: string;
  turn: number;
  timestamp: string;
}

const SENSITIVE_ARG_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
    "$1=[REDACTED]",
  ],
  [
    /(--?(?:token|api-key|apikey|password|secret|auth)[=\s]+)(?:"[^"]*"|'[^']*'|\S+)/gi,
    "$1[REDACTED]",
  ],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_KEY]"],
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_TOKEN]"],
];

/**
 * Redacts credentials/env assignments and bounds length so progress streams
 * never expose secrets or verbose command payloads.
 */
export function sanitizeCommandSummary(rawCommand: string, maxLength = 72): string {
  let clean = rawCommand.replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SENSITIVE_ARG_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }
  if (clean.length > maxLength) {
    clean = `${clean.slice(0, maxLength - 3)}...`;
  }
  return clean;
}

/**
 * Channel-agnostic progress stream translator used by Browser SSE, Telegram, and scheduled tasks.
 */
export class AgentProgressStream {
  private readonly listeners = new Set<(event: ProgressEvent) => void | Promise<void>>();
  private readonly history: ProgressEvent[] = [];

  subscribe(listener: (event: ProgressEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getEvents(): ProgressEvent[] {
    return [...this.history];
  }

  async emitStage(
    stage: ProgressStage,
    label: string,
    turn: number,
    detail?: string
  ): Promise<ProgressEvent> {
    const event: ProgressEvent = {
      id: `prog_${crypto.randomUUID().slice(0, 8)}`,
      stage,
      label,
      detail,
      turn,
      timestamp: new Date().toISOString(),
    };
    this.history.push(event);
    for (const listener of this.listeners) {
      await listener(event);
    }
    return event;
  }

  async handlePhase(phase: "analyzing_request" | "calling_gemini" | "reviewing_changes", turn: number): Promise<void> {
    if (phase === "analyzing_request") {
      await this.emitStage("analyzing_request", "Analyzing request", turn);
    } else if (phase === "calling_gemini") {
      await this.emitStage("calling_gemini", "Calling Gemini", turn);
    } else if (phase === "reviewing_changes") {
      await this.emitStage("reviewing_changes", "Reviewing changes", turn);
    }
  }

  async handleAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "command_started":
        await this.emitStage(
          "running_command",
          "Running command",
          event.turn,
          event.command ? sanitizeCommandSummary(event.command) : undefined
        );
        break;
      case "command_completed":
        await this.emitStage(
          "command_completed",
          "Command completed",
          event.turn,
          event.command ? sanitizeCommandSummary(event.command) : undefined
        );
        break;
      case "command_failed":
        await this.emitStage(
          "command_failed",
          "Command failed",
          event.turn,
          event.command ? sanitizeCommandSummary(event.command) : undefined
        );
        break;
      case "tool_call_requested":
        if (event.toolName === "write_local_file") {
          const target =
            typeof event.args?.file_path === "string" ? event.args.file_path : "file";
          await this.emitStage("running_command", "Updating workspace file", event.turn, target);
        }
        break;
      case "final_response":
        await this.emitStage("finished", "Finished", event.turn);
        break;
      case "execution_error":
        await this.emitStage("error", "Execution error", event.turn, event.error);
        break;
      default:
        break;
    }
  }
}
