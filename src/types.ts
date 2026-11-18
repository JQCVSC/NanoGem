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
  configuredModel?: string;
  modelUsed?: string;
  fallbackUsed?: boolean;
}

export interface NanoGeminiSource {
  readme: string;
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

export interface ContainerRuntimeInfo {
  configuredRuntime?: "auto" | "docker" | "podman";
  selectedRuntime?: "docker" | "podman" | null;
  image: string;
  user: string;
  network: string;
  networkEnabled?: boolean;
  executionMode?: "docker" | "host";
  cpus: string;
  memory: string;
  pidsLimit: number;
  readOnly: boolean;
  available: boolean;
  imagePresent: boolean;
  serverVersion?: string;
  error?: string;
  remediation?: string;
}

export interface RuntimeStatus {
  executionMode: "docker" | "host";
  authRequired: boolean;
  isPublicBind?: boolean;
  provider?: {
    id: string;
    displayName: string;
    apiKeyConfigured: boolean;
  };
  containerRuntime?: ContainerRuntimeInfo | null;
  docker: ContainerRuntimeInfo | null;
  telegram?: {
    configured: boolean;
    polling: boolean;
    allowedUsersCount: number;
    allowedChatsCount: number;
    requireMention: boolean;
  };
  schedules?: {
    enabledByEnv: boolean;
  };
  projectContext?: {
    projectId: string;
    hasGeminiMd: boolean;
    hasMemoryMd: boolean;
    isGitRepo: boolean;
    hasUncommittedChanges: boolean;
    branch: string | null;
  };
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

export interface AgentProgressEvent {
  id: string;
  stage:
    | "analyzing_request"
    | "calling_gemini"
    | "running_command"
    | "command_completed"
    | "command_failed"
    | "reviewing_changes"
    | "finished"
    | "error";
  label: string;
  detail?: string;
  turn: number;
  timestamp: string;
}

export interface GitFileEntry {
  path: string;
  indexStatus: string;
  workTreeStatus: string;
  label: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
}

export interface GitStatusInfo {
  isGitRepo: boolean;
  branch: string | null;
  headCommit: string | null;
  clean: boolean;
  hasUncommittedChanges: boolean;
  entries: GitFileEntry[];
  message?: string;
}

export interface GitDiffInfo {
  isGitRepo: boolean;
  diff: string;
  untrackedFiles: string[];
  truncated: boolean;
  message?: string;
}

export interface ScheduledTaskInfo {
  id: string;
  projectId: string;
  name: string;
  taskKind: "test_run" | "repo_status" | "dependency_report";
  scheduleExpr: string;
  promptOverride: string | null;
  enabled: boolean;
  notifyTelegramChatId: string | null;
  lastStatus: "idle" | "running" | "succeeded" | "failed" | "paused";
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  lastOutput: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskRunInfo {
  id: string;
  taskId: string;
  projectId: string;
  sessionId: string | null;
  status: "running" | "succeeded" | "failed" | "cancelled";
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowTemplateInfo {
  id: "technical_research" | "doc_generation" | "data_analysis" | "python_report";
  title: string;
  description: string;
  outputFormat: string;
  allowedExtensions: string[];
  maxFileBytes: number;
  maxTotalBytes: number;
  defaultGoal: string;
}

export interface AgentRequestError {
  error: string;
  code?: string;
  retryable: boolean;
  status?: number;
  failedPrompt: string;
}
