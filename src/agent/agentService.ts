import fs from "fs/promises";
import path from "path";
import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import {
  executeSandboxCommandDetailed,
  resolveSafeWorkspacePath,
  type SandboxCommandResult,
  type SandboxConfig,
} from "../server/sandboxRuntime.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
export const DEFAULT_MAX_TURNS = 8;

export const DEFAULT_SYSTEM_INSTRUCTION = `You are NanoGemini, an autonomous developer agent running inside a secure, isolated Docker sandbox.
You have the ability to execute bash terminal commands and write files directly to the file system.
Your working directory is restricted to \`/workspace/\`. 
If a user asks you to build an app or run a script, create the files, install the dependencies via bash, run commands, and verify it works.
Always think step-by-step. Use your tools immediately when needed without asking for permission.`;

const PLACEHOLDER_GEMINI_KEYS = new Set([
  "MY_GEMINI_API_KEY",
  "your_gemini_api_key_here",
]);

export interface AgentHistoryMessage {
  role: "user" | "assistant" | "model";
  content: string;
}

export interface AgentExecutionStep {
  type: "tool_call" | "text_response";
  toolName?: string;
  args?: Record<string, unknown>;
  output?: string;
  text?: string;
}

export type AgentEvent =
  | { type: "assistant_text"; turn: number; text: string; timestamp: string }
  | {
      type: "tool_call_requested";
      turn: number;
      toolName: string;
      args: Record<string, unknown>;
      timestamp: string;
    }
  | {
      type: "tool_result";
      turn: number;
      toolName: string;
      output: string;
      success: boolean;
      timestamp: string;
    }
  | { type: "command_started"; turn: number; command: string; timestamp: string }
  | {
      type: "command_completed";
      turn: number;
      command: string;
      output: string;
      timestamp: string;
    }
  | {
      type: "command_failed";
      turn: number;
      command: string;
      output: string;
      error: string;
      timestamp: string;
    }
  | {
      type: "final_response";
      turn: number;
      text: string;
      maxTurnsReached: boolean;
      timestamp: string;
    }
  | { type: "execution_error"; turn: number; error: string; timestamp: string };

export interface GeminiGenerateContentResponse {
  text?: string;
  candidates?: Array<{ content?: unknown }>;
  functionCalls?: Array<{ name?: string; args?: unknown }>;
}

export interface GeminiGenerateContentClient {
  models: {
    generateContent(params: {
      model: string;
      contents: unknown[];
      config?: Record<string, unknown>;
    }): Promise<GeminiGenerateContentResponse>;
  };
}

export interface AgentRunInput {
  message: string;
  history?: AgentHistoryMessage[];
  model?: string;
  temperature?: number;
  systemInstruction?: string;
  maxTurns?: number;
  protectContextFiles?: boolean;
  sandboxConfig: SandboxConfig;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface AgentRunResult {
  text: string;
  executionSteps: AgentExecutionStep[];
  events: AgentEvent[];
  turns: number;
  maxTurnsReached: boolean;
}

export interface AgentServiceDependencies {
  client?: GeminiGenerateContentClient;
  apiKey?: string;
  executeCommand?: (
    command: string,
    config: SandboxConfig
  ) => Promise<SandboxCommandResult>;
}

export const agentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: "execute_system_command",
    description:
      "Executes a bash terminal command in the /workspace/ directory and returns the console output.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description:
            "The bash command to run (e.g., 'npm init -y', 'python app.py', or 'ls -la')",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "write_local_file",
    description:
      "Writes string content to a file. Relative paths are automatically resolved to /workspace/.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_path: {
          type: Type.STRING,
          description: "The relative file path (e.g., 'index.js' or 'src/App.js').",
        },
        content: {
          type: Type.STRING,
          description: "The file content to write.",
        },
      },
      required: ["file_path", "content"],
    },
  },
];

export function isConfiguredGeminiApiKey(rawKey: string | undefined): boolean {
  const trimmed = rawKey?.trim() || "";
  return Boolean(trimmed) && !PLACEHOLDER_GEMINI_KEYS.has(trimmed);
}

export function createDefaultGeminiClient(
  apiKey: string | undefined = process.env.GEMINI_API_KEY
): GeminiGenerateContentClient {
  const trimmed = apiKey?.trim() || "";
  if (!isConfiguredGeminiApiKey(trimmed)) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }
  return new GoogleGenAI({
    apiKey: trimmed,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  }) as unknown as GeminiGenerateContentClient;
}

export async function writeWorkspaceFile(
  workspaceDir: string,
  filePath: string,
  content: string,
  options: { protectContextFiles?: boolean } = {}
): Promise<{ ok: boolean; output: string }> {
  const safePath = await resolveSafeWorkspacePath(workspaceDir, filePath);
  if (!safePath) {
    return {
      ok: false,
      output: "Security Error: Cannot write files outside of /workspace/",
    };
  }
  if (options.protectContextFiles) {
    const normalizedRel = path.relative(workspaceDir, safePath).replace(/\\/g, "/").toLowerCase();
    if (normalizedRel === "gemini.md" || normalizedRel === "memory.md") {
      return {
        ok: false,
        output:
          `Protected Context File: Cannot silently overwrite /workspace/${path.basename(safePath)}. ` +
          `Show the proposed changes to the user so they can explicitly save them to project instructions/memory.`,
      };
    }
  }
  try {
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, content, "utf-8");
    const relativePath = path.relative(workspaceDir, safePath);
    return {
      ok: true,
      output: `Success: Wrote to /workspace/${relativePath}`,
    };
  } catch (error: any) {
    return {
      ok: false,
      output: `Error writing file: ${error?.message || String(error)}`,
    };
  }
}

function normalizeMaxTurns(raw?: number): number {
  if (raw === undefined) return DEFAULT_MAX_TURNS;
  if (!Number.isInteger(raw) || raw < 1 || raw > 32) {
    throw new Error("Invalid maxTurns: expected an integer between 1 and 32.");
  }
  return raw;
}

function buildInitialContents(
  message: string,
  history: AgentHistoryMessage[] = []
): unknown[] {
  const contents: unknown[] = [];
  for (const item of history) {
    if (item && typeof item.role === "string" && typeof item.content === "string") {
      contents.push({
        role: item.role === "user" ? "user" : "model",
        parts: [{ text: item.content }],
      });
    }
  }
  contents.push({
    role: "user",
    parts: [{ text: message }],
  });
  return contents;
}

/**
 * Executes a single Gemini agent turn loop with sandboxed tool calling,
 * structured lifecycle events, and maximum-turn protection.
 */
export async function runGeminiAgent(
  input: AgentRunInput,
  deps: AgentServiceDependencies = {}
): Promise<AgentRunResult> {
  if (typeof input.message !== "string" || !input.message.trim()) {
    throw new Error("Message is required.");
  }

  const maxTurns = normalizeMaxTurns(input.maxTurns);
  const model = input.model?.trim() || DEFAULT_GEMINI_MODEL;
  const temperature =
    typeof input.temperature === "number" && Number.isFinite(input.temperature)
      ? input.temperature
      : 0;
  const systemInstruction = input.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION;
  const executeCommand = deps.executeCommand ?? executeSandboxCommandDetailed;

  const events: AgentEvent[] = [];
  const executionSteps: AgentExecutionStep[] = [];
  const emit = async (event: AgentEvent): Promise<void> => {
    events.push(event);
    if (input.onEvent) {
      await input.onEvent(event);
    }
  };

  let currentTurnCount = 0;
  let finalText = "";
  let maxTurnsReached = false;
  const currentContents = buildInitialContents(input.message, input.history);

  try {
    const client = deps.client ?? createDefaultGeminiClient(deps.apiKey);

    while (currentTurnCount < maxTurns) {
      currentTurnCount++;

      const response = await client.models.generateContent({
        model,
        contents: currentContents,
        config: {
          systemInstruction,
          temperature,
          tools: [{ functionDeclarations: agentFunctionDeclarations }],
        },
      });

      const candidate = response.candidates?.[0];
      if (!candidate) {
        finalText = response.text || "No response candidate generated.";
        if (finalText) {
          await emit({
            type: "assistant_text",
            turn: currentTurnCount,
            text: finalText,
            timestamp: new Date().toISOString(),
          });
        }
        await emit({
          type: "final_response",
          turn: currentTurnCount,
          text: finalText,
          maxTurnsReached: false,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        if (candidate.content) {
          currentContents.push(candidate.content);
        }

        const functionResponsesParts: unknown[] = [];

        for (const call of functionCalls) {
          const fnName = call.name || "unknown_tool";
          const fnArgs = (
            call.args && typeof call.args === "object" ? call.args : {}
          ) as Record<string, unknown>;

          await emit({
            type: "tool_call_requested",
            turn: currentTurnCount,
            toolName: fnName,
            args: fnArgs,
            timestamp: new Date().toISOString(),
          });

          let toolResult = "";
          let toolSuccess = false;

          if (fnName === "execute_system_command") {
            const command = fnArgs.command;
            if (typeof command === "string" && command.trim()) {
              await emit({
                type: "command_started",
                turn: currentTurnCount,
                command,
                timestamp: new Date().toISOString(),
              });
              const cmdResult = await executeCommand(command, input.sandboxConfig);
              toolResult = cmdResult.output;
              toolSuccess = cmdResult.ok;
              if (cmdResult.ok) {
                await emit({
                  type: "command_completed",
                  turn: currentTurnCount,
                  command,
                  output: cmdResult.output,
                  timestamp: new Date().toISOString(),
                });
              } else {
                await emit({
                  type: "command_failed",
                  turn: currentTurnCount,
                  command,
                  output: cmdResult.output,
                  error: cmdResult.error || cmdResult.output,
                  timestamp: new Date().toISOString(),
                });
              }
            } else {
              toolResult =
                "Error: Invalid arguments for execute_system_command (expected non-empty string 'command').";
              await emit({
                type: "command_failed",
                turn: currentTurnCount,
                command: "",
                output: toolResult,
                error: toolResult,
                timestamp: new Date().toISOString(),
              });
            }
          } else if (fnName === "write_local_file") {
            if (
              typeof fnArgs.file_path === "string" &&
              typeof fnArgs.content === "string"
            ) {
              const writeResult = await writeWorkspaceFile(
                input.sandboxConfig.workspaceDir,
                fnArgs.file_path,
                fnArgs.content,
                { protectContextFiles: input.protectContextFiles !== false }
              );
              toolResult = writeResult.output;
              toolSuccess = writeResult.ok;
            } else {
              toolResult =
                "Error: Invalid arguments for write_local_file (expected string 'file_path' and 'content').";
            }
          } else {
            toolResult = `Unknown function: ${fnName}`;
          }

          await emit({
            type: "tool_result",
            turn: currentTurnCount,
            toolName: fnName,
            output: toolResult,
            success: toolSuccess,
            timestamp: new Date().toISOString(),
          });

          executionSteps.push({
            type: "tool_call",
            toolName: fnName,
            args: fnArgs,
            output: toolResult,
          });

          functionResponsesParts.push({
            functionResponse: {
              name: fnName,
              response: { result: toolResult },
            },
          });
        }

        currentContents.push({
          role: "user",
          parts: functionResponsesParts,
        });

        if (currentTurnCount >= maxTurns) {
          maxTurnsReached = true;
          const limitMessage = `Reached maximum turn limit (${maxTurns}) before completing the task.`;
          finalText = limitMessage;
          await emit({
            type: "execution_error",
            turn: currentTurnCount,
            error: limitMessage,
            timestamp: new Date().toISOString(),
          });
          await emit({
            type: "final_response",
            turn: currentTurnCount,
            text: finalText,
            maxTurnsReached: true,
            timestamp: new Date().toISOString(),
          });
          break;
        }
      } else {
        finalText = response.text || "";
        executionSteps.push({
          type: "text_response",
          text: finalText,
        });
        await emit({
          type: "assistant_text",
          turn: currentTurnCount,
          text: finalText,
          timestamp: new Date().toISOString(),
        });
        await emit({
          type: "final_response",
          turn: currentTurnCount,
          text: finalText,
          maxTurnsReached: false,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }

    return {
      text: finalText,
      executionSteps,
      events,
      turns: currentTurnCount,
      maxTurnsReached,
    };
  } catch (error: any) {
    const errorMessage = error?.message || "Agent execution failed.";
    await emit({
      type: "execution_error",
      turn: currentTurnCount,
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
    throw error;
  }
}
