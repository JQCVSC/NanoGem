export interface WorkspaceFile {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  updatedAt?: string;
  children?: WorkspaceFile[];
}

export interface ExecutionStep {
  type: "tool_call" | "text_response";
  toolName?: string;
  args?: {
    command?: string;
    file_path?: string;
    content?: string;
    [key: string]: any;
  };
  output?: string;
  text?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  executionSteps?: ExecutionStep[];
  isStreaming?: boolean;
}

export interface NanoGeminiSource {
  dockerfile: string;
  requirements: string;
  envExample: string;
  agentPy: string;
  startSandboxSh: string;
}

export interface AgentSettings {
  model: string;
  temperature: number;
  systemInstruction: string;
  sandboxDir: string;
}
