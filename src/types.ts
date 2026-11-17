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

export interface RuntimeStatus {
  executionMode: "docker" | "host";
  authRequired: boolean;
  docker: {
    image: string;
    user: string;
    network: string;
    cpus: string;
    memory: string;
    pidsLimit: number;
    readOnly: boolean;
    available: boolean;
    imagePresent: boolean;
    serverVersion?: string;
    error?: string;
  } | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  workspacePath: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  channel: string;
  externalChatId: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
}
