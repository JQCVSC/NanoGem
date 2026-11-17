import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { createServer as createViteServer } from "vite";
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_SYSTEM_INSTRUCTION,
  writeWorkspaceFile,
} from "./src/agent/agentService.ts";
import { resolveAgentProvider } from "./src/agent/provider.ts";
import {
  DEFAULT_GEMINI_MD_TEMPLATE,
  DEFAULT_MEMORY_MD_TEMPLATE,
  MAX_PROJECT_CONTEXT_BYTES,
  appendCuratedProjectMemory,
  buildProjectSystemInstruction,
  loadProjectInstructionsAndMemory,
  saveProjectContextFile,
} from "./src/agent/projectContext.ts";
import {
  AgentProgressStream,
  type ProgressEvent,
} from "./src/agent/progressStream.ts";
import {
  commitGitChanges,
  createGitBranch,
  getGitDiff,
  getGitStatus,
  revertGitWorkspace,
} from "./src/git/gitReviewService.ts";
import {
  applySecurityHeaders,
  createApiAuthMiddleware,
  loadServerSecurityConfig,
} from "./src/server/auth.ts";
import {
  checkContainerRuntimeAvailability,
  executeSandboxCommand,
  loadSandboxConfig,
} from "./src/server/sandboxRuntime.ts";
import { openNanoGemDatabase } from "./src/storage/database.ts";
import { ProjectStore, type ProjectRecord } from "./src/storage/projectStore.ts";
import { SessionStore, type SessionRecord } from "./src/storage/sessionStore.ts";
import { TelegramMappingStore } from "./src/storage/telegramMappingStore.ts";
import { ScheduleStore } from "./src/storage/scheduleStore.ts";
import { loadTelegramConfig } from "./src/channels/telegram/config.ts";
import { TelegramChannelAdapter } from "./src/channels/telegram/telegramAdapter.ts";
import {
  SchedulerService,
  isSchedulingEnabledByEnv,
} from "./src/scheduler/schedulerService.ts";
import {
  WORKFLOW_DATA_HANDLING_NOTICE,
  WORKFLOW_TEMPLATES,
  prepareWorkflowPrompt,
} from "./src/workflows/projectWorkflows.ts";

const app = express();

app.disable("x-powered-by");
app.use(applySecurityHeaders);
app.use(express.json({ limit: "10mb" }));

// 1. Setup Sandbox Workspace Directory, Persistent Storage & Runtime Configuration
const WORKSPACE_DIR = path.resolve(process.cwd(), "sandbox_workspace");
const PROJECTS_ROOT = path.resolve(
  process.env.NANOGEM_PROJECTS_ROOT?.trim() || path.join(process.cwd(), "nanogem_workspaces")
);
const DB_PATH = path.resolve(
  process.env.NANOGEM_DB_PATH?.trim() || path.join(process.cwd(), ".nanogem", "nanogem.db")
);

const sandboxConfig = loadSandboxConfig(WORKSPACE_DIR);
const securityConfig = loadServerSecurityConfig();
const agentProvider = resolveAgentProvider();
const telegramConfig = loadTelegramConfig();
const db = openNanoGemDatabase(DB_PATH);
const projectStore = new ProjectStore(db, PROJECTS_ROOT);
const sessionStore = new SessionStore(db);
const telegramMappingStore = new TelegramMappingStore(db, projectStore, sessionStore);
const scheduleStore = new ScheduleStore(db);
const telegramAdapter = new TelegramChannelAdapter({
  config: telegramConfig,
  sandboxConfig,
  projectStore,
  sessionStore,
  mappingStore: telegramMappingStore,
  agentProvider,
});
const schedulerService = new SchedulerService({
  enabledByEnv: isSchedulingEnabledByEnv(),
  sandboxConfig,
  projectStore,
  sessionStore,
  scheduleStore,
  mappingStore: telegramMappingStore,
  telegramConfig,
  agentProvider,
  sendTelegramMessage: (chatId, text) => telegramAdapter.sendNotification(chatId, text),
});

app.use("/api", createApiAuthMiddleware(securityConfig));

function ensureWorkspace() {
  if (!existsSync(WORKSPACE_DIR)) {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    // Seed initial files
    const readmeContent = [
      "# ♊ NanoGemini",
      "",
      "**A highly-secure, Docker-sandboxed AI agent runtime built natively for Google Gemini.**",
      "",
      "NanoGemini is an ultra-lightweight, auditable AI-assistant harness. It gives Gemini 2.5 Flash and Pro models the ability to execute code, manage files, and run terminal commands autonomously—but **strictly inside an isolated Linux container.**",
      "",
      "If the agent accidentally runs `rm -rf /`, it only destroys a temporary sandbox, not your host machine.",
      "",
      "---",
      "",
      "## 📖 Core Philosophy",
      "",
      "* **Gemini-Native.** Built specifically to exploit Gemini's massive 2-million token context window and native multimodal (vision/audio) capabilities. No RAG or vector DBs required—just feed it entire codebases.",
      "* **Secure by Isolation.** Agents do not run on your host machine. They run in ephemeral Docker containers. They can only see the workspace directories you explicitly mount.",
      "* **Small Enough to Understand.** One core Python process. No microservices. The entire codebase is small enough that you can ask Gemini to read and explain it to you in one prompt.",
      "* **Destructive Freedom.** Because the agent is sandboxed, you can give it unrestricted `bash` access to build apps, install dependencies, and debug its own code without fear.",
      "",
      "---",
      "",
      "## 🏗️ Architecture",
      "",
      "NanoGemini uses a simple \"Host ↔ Container\" model. The host machine runs the setup script and Docker daemon, while the Gemini API execution loop runs entirely inside the sandbox.",
      "",
      "```text",
      "nanogemini/",
      "├── Dockerfile             # The secure Debian-based sandbox definition",
      "├── requirements.txt       # Sandbox dependencies (google-genai, etc.)",
      "├── agent.py               # The core agent loop running inside Docker",
      "├── tools.py               # Function Call mappings (bash execution, file I/O)",
      "└── start_sandbox.sh       # Host script to mount volumes and launch the agent",
      "```",
      "",
      "---",
      "",
      "## ✨ Key Features",
      "- **Perfect Recall Memory:** Utilize Gemini's massive context window to load entire projects into MEMORY.md.",
      "- **True Sandbox Execution:** `execute_system_command` runs directly in the container, meaning the agent can safely run npm install, compile code, or test bash scripts.",
      "- **Restricted File I/O:** The `write_local_file` tool automatically restricts the agent's reach to a mounted `/workspace/` directory, preventing directory traversal attacks.",
      "- **Flash Economics:** Powered by `gemini-2.5-flash` by default for ultra-fast, low-cost autonomous background loops.",
      "",
      "---",
      "",
      "## 🚀 Quick Start",
      "### Prerequisites",
      "- macOS or Linux (Windows via WSL2)",
      "- Docker installed and running",
      "- A Google Gemini API Key (Get one from Google AI Studio)",
      "",
      "### 1. Clone & Configure",
      "```bash",
      "git clone https://github.com/your-username/nanogemini.git",
      "cd nanogemini",
      "",
      "# Create your environment file",
      "echo \"GEMINI_API_KEY=your_api_key_here\" > .env",
      "```",
      "",
      "### 2. Start the Sandbox",
      "Run the host startup script. This will build the Docker container and mount a local folder (`./my_local_workspace`) from your machine into the container's `/workspace`.",
      "",
      "```bash",
      "chmod +x start_sandbox.sh",
      "./start_sandbox.sh",
      "```",
      "",
      "### 3. Talk to NanoGemini",
      "Once the container starts, you will drop into an interactive prompt. Try asking the agent to build something:",
      "",
      "> **[You]:** Create a new React project in this folder, install tailwindcss, and configure the tailwind.config.js file for me.",
      "",
      "Watch as NanoGemini executes the terminal commands inside the container, and the files appear instantly in your host's `./my_local_workspace` folder!",
      "",
      "---",
      "",
      "## 🧠 Advanced Usage: Customizing the \"Soul\"",
      "NanoGemini's personality and operational rules are defined by its System Instructions. You can modify these directly in `agent.py`:",
      "",
      "```python",
      "SYSTEM_INSTRUCTION = \"\"\"",
      "You are NanoGemini, a senior security engineer.",
      "Your working directory is restricted to `/workspace/`.",
      "Do not ask for permission before running bash commands to audit code.",
      "Always think step-by-step and write a summary to `audit_report.md` when finished.",
      "\"\"\"",
      "```",
      "",
      "---",
      "",
      "## 🛡️ Security Disclaimer",
      "While NanoGemini runs inside a Docker container, Docker is not a perfect security boundary against dedicated malicious actors (container escape vulnerabilities exist).",
      "",
      "* Do not mount sensitive host directories (like `~/.ssh/` or `/etc/`) into the container.",
      "* Do not pass your primary AWS/GCP root credentials as environment variables to the sandbox.",
      "",
      "---",
      "",
      "## 🤝 Contributing",
      "We welcome contributions! Whether it's adding new multimodal tools (like allowing the agent to \"see\" screenshots of the UI it just built) or optimizing the Docker build, feel free to submit a PR.",
      "",
      "---",
      "",
      "## 📄 License",
      "This project is licensed under the MIT License - see the LICENSE file for details.",
    ].join("\n");

    writeFileSync(path.join(WORKSPACE_DIR, "README.md"), readmeContent);
    writeFileSync(
      path.join(WORKSPACE_DIR, "app.py"),
      `# Sample Python Application in NanoGemini Sandbox
import sys

def main():
    print("Hello from NanoGemini Sandbox!")
    print(f"Python version: \${sys.version}")

if __name__ == "__main__":
    main()
`
    );
    writeFileSync(
      path.join(WORKSPACE_DIR, "package.json"),
      JSON.stringify(
        {
          name: "sandbox-app",
          version: "1.0.0",
          description: "NanoGemini Sandbox Workspace Project",
          main: "index.js",
          scripts: {
            start: "node index.js",
            test: 'echo "Error: no test specified" && exit 0',
          },
          dependencies: {},
        },
        null,
        2
      )
    );
    writeFileSync(
      path.join(WORKSPACE_DIR, "index.js"),
      `// Sample Node.js File\nconsole.log("NanoGemini Sandbox Node Engine initialized.");\n`
    );
  }
}

ensureWorkspace();
projectStore.ensureDefaultProject(WORKSPACE_DIR);
sessionStore.ensureDefaultSession("default");

function resolveProjectContext(
  rawProjectId: unknown,
  rawSessionId?: unknown
): {
  project?: ProjectRecord;
  session?: SessionRecord;
  errorStatus?: number;
  errorMessage?: string;
} {
  const projectId =
    typeof rawProjectId === "string" && rawProjectId.trim()
      ? rawProjectId.trim()
      : "default";
  const project = projectStore.getProjectById(projectId);
  if (!project) {
    return { errorStatus: 404, errorMessage: `Project "${projectId}" not found.` };
  }

  if (typeof rawSessionId === "string" && rawSessionId.trim()) {
    const sessionId = rawSessionId.trim();
    const session = sessionStore.getSession(sessionId);
    if (!session) {
      return { errorStatus: 404, errorMessage: `Session "${sessionId}" not found.` };
    }
    if (session.projectId !== project.id) {
      return {
        errorStatus: 403,
        errorMessage: "Forbidden: session does not belong to the selected project.",
      };
    }
    return { project, session };
  }

  return { project };
}

async function getWorkspaceFilesTree(dir = WORKSPACE_DIR, relative = ""): Promise<any[]> {
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    const relPath = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const children = await getWorkspaceFilesTree(fullPath, relPath);
      results.push({
        name: entry.name,
        path: relPath,
        isDirectory: true,
        children,
      });
    } else if (entry.isFile()) {
      const stats = await fs.lstat(fullPath);
      results.push({
        name: entry.name,
        path: relPath,
        isDirectory: false,
        size: stats.size,
        updatedAt: stats.mtime,
      });
    }
  }

  return results.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
}

// --- REST API ENDPOINTS ---

// Healthcheck
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    executionMode: sandboxConfig.executionMode,
    authRequired: securityConfig.authRequired,
  });
});

// Runtime sandbox posture, container runtime detection, provider readiness, Telegram, and active project status
app.get("/api/runtime/status", async (req, res) => {
  const runtimeProbe =
    sandboxConfig.executionMode === "docker"
      ? await checkContainerRuntimeAvailability(sandboxConfig)
      : null;

  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : "default";
  const project = projectStore.getProjectById(projectId);
  let projectContext: Record<string, unknown> | undefined;
  if (project) {
    const [ctxFiles, gitStatus] = await Promise.all([
      loadProjectInstructionsAndMemory(project.workspacePath),
      getGitStatus(project.workspacePath),
    ]);
    projectContext = {
      projectId: project.id,
      hasGeminiMd: ctxFiles.hasGeminiMd,
      hasMemoryMd: ctxFiles.hasMemoryMd,
      isGitRepo: gitStatus.isGitRepo,
      hasUncommittedChanges: gitStatus.hasUncommittedChanges,
      branch: gitStatus.branch,
    };
  }

  const runtimeDetails =
    sandboxConfig.executionMode === "docker" && runtimeProbe
      ? {
          configuredRuntime: runtimeProbe.configuredRuntime,
          selectedRuntime: runtimeProbe.selectedRuntime,
          image: runtimeProbe.image,
          user: sandboxConfig.dockerUser,
          network: runtimeProbe.network,
          networkEnabled: runtimeProbe.networkEnabled,
          executionMode: runtimeProbe.executionMode,
          cpus: sandboxConfig.dockerCpus,
          memory: sandboxConfig.dockerMemory,
          pidsLimit: sandboxConfig.dockerPidsLimit,
          readOnly: sandboxConfig.dockerReadOnly,
          available: runtimeProbe.available,
          imagePresent: runtimeProbe.imagePresent,
          serverVersion: runtimeProbe.serverVersion,
          error: runtimeProbe.error,
          remediation: runtimeProbe.remediation,
        }
      : null;

  res.json({
    executionMode: sandboxConfig.executionMode,
    authRequired: securityConfig.authRequired,
    isPublicBind: securityConfig.isPublicBind,
    provider: {
      id: agentProvider.id,
      displayName: agentProvider.displayName,
      apiKeyConfigured: agentProvider.isConfigured(),
    },
    containerRuntime: runtimeDetails,
    docker: runtimeDetails,
    telegram: {
      configured: telegramConfig.enabled,
      polling: telegramConfig.enabled && telegramConfig.polling,
      allowedUsersCount: telegramConfig.allowedUserIds.size,
      allowedChatsCount: telegramConfig.allowedChatIds.size,
      requireMention: telegramConfig.requireMention,
    },
    schedules: {
      enabledByEnv: schedulerService.enabledByEnv,
    },
    projectContext,
  });
});

// GET Source code of NanoGemini python codebase for export & inspection
app.get("/api/nanogemini/source", (req, res) => {
  const codebase = {
    dockerfile: `FROM node:22-bookworm-slim

ARG SANDBOX_UID=1000
ARG SANDBOX_GID=1000

RUN printf '%s' "\${SANDBOX_UID}" | grep -Eq '^[1-9][0-9]*$' \\
  && printf '%s' "\${SANDBOX_GID}" | grep -Eq '^[1-9][0-9]*$' \\
  && apt-get update \\
  && apt-get install -y --no-install-recommends \\
    bash \\
    ca-certificates \\
    git \\
    python3 \\
    python3-pip \\
    python3-venv \\
    python-is-python3 \\
  && apt-get clean \\
  && rm -rf /var/lib/apt/lists/* \\
  && find / -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true

RUN (userdel -r node 2>/dev/null || true) \\
  && (groupdel node 2>/dev/null || true) \\
  && groupadd -g "\${SANDBOX_GID}" sandbox \\
  && useradd -m -u "\${SANDBOX_UID}" -g "\${SANDBOX_GID}" -d /home/sandbox -s /bin/bash sandbox \\
  && mkdir -p /workspace \\
  && chown -R "\${SANDBOX_UID}:\${SANDBOX_GID}" /workspace /home/sandbox

ENV HOME=/home/sandbox \\
    PYTHONDONTWRITEBYTECODE=1 \\
    PIP_NO_CACHE_DIR=1 \\
    NPM_CONFIG_CACHE=/home/sandbox/.npm

WORKDIR /workspace
USER sandbox

CMD ["/bin/bash"]`,
    requirements: `google-genai>=0.1.1\npython-dotenv>=1.0.0`,
    envExample: `GEMINI_API_KEY=your_gemini_api_key_here\nHOST=127.0.0.1\nNANOGEM_EXECUTION_MODE=docker\nNANOGEM_SANDBOX_IMAGE=nanogem-sandbox:latest\nNANOGEM_DOCKER_NETWORK=none\nNANOGEM_DOCKER_READ_ONLY=true`,
    agentPy: `import os
import subprocess
from google import genai
from google.genai import types

client = genai.Client()

SYSTEM_INSTRUCTION = """
You are NanoGemini, an autonomous developer agent running inside a secure, isolated Docker sandbox.
You have the ability to execute bash terminal commands and write files directly to the file system.
Your working directory is restricted to \`/workspace/\`. 
If a user asks you to build an app, create the files, install the dependencies via bash, and verify it works.
Always think step-by-step. Use your tools immediately when needed without asking for permission.
"""

WORKSPACE_DIR = "/workspace"

def execute_system_command(command: str) -> str:
    """Executes a bash terminal command and returns the output."""
    try:
        result = subprocess.run(
            command, 
            shell=True, 
            cwd=WORKSPACE_DIR,
            capture_output=True, 
            text=True,
            timeout=30
        )
        return result.stdout if result.returncode == 0 else result.stderr
    except subprocess.TimeoutExpired:
        return "Error: Command timed out after 30 seconds."
    except Exception as e:
        return f"Error executing command: {str(e)}"

def write_local_file(file_path: str, content: str) -> str:
    """Writes content to a file in the workspace."""
    safe_path = os.path.abspath(os.path.join(WORKSPACE_DIR, file_path))
    if not safe_path.startswith(WORKSPACE_DIR):
        return "Security Error: Cannot write files outside of /workspace/"

    try:
        os.makedirs(os.path.dirname(safe_path), exist_ok=True)
        with open(safe_path, 'w') as f:
            f.write(content)
        return f"Success: Wrote to {safe_path}"
    except Exception as e:
        return f"Error writing file: {str(e)}"

TOOL_REGISTRY = {
    "execute_system_command": execute_system_command,
    "write_local_file": write_local_file,
}

agent_tools = [
    {
        "type": "function",
        "name": "execute_system_command",
        "description": "Executes a bash terminal command in the /workspace/ directory and returns the console output.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The bash command to run (e.g., 'npm init -y' or 'ls -la')"}
            },
            "required": ["command"]
        }
    },
    {
        "type": "function",
        "name": "write_local_file",
        "description": "Writes string content to a file. Relative paths are automatically resolved to /workspace/.",
        "parameters": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "The relative file path (e.g., 'index.js' or 'src/App.js')."},
                "content": {"type": "string", "description": "The file content to write."}
            },
            "required": ["file_path", "content"]
        }
    }
]

def run_interactive_loop():
    print("🚀 NanoGemini Sandbox Started.")
    print("Type 'exit' to quit.\\n")
    
    chat = client.chats.create(
        model="gemini-2.5-flash",
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            temperature=0,
            tools=agent_tools,
        )
    )

    while True:
        try:
            user_input = input("\\n[You]: ")
            if user_input.lower() in ['exit', 'quit']:
                break
            if not user_input.strip():
                continue

            response = chat.send_message(user_input)

            while response.function_calls:
                results = []
                for tool_call in response.function_calls:
                    fn_name = tool_call.name
                    fn_args = tool_call.args
                    print(f"\\n[Agent Executing]: {fn_name}({fn_args})")
                    if fn_name in TOOL_REGISTRY:
                        output = TOOL_REGISTRY[fn_name](**fn_args)
                    else:
                        output = f"Unknown tool: {fn_name}"
                        
                    results.append(
                        types.Part.from_function_response(
                            name=fn_name,
                            response={"result": str(output)}
                        )
                    )
                response = chat.send_message(results)
            
            print(f"\\n[NanoGemini]: {response.text}")

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"\\n[System Error]: {str(e)}")

if __name__ == "__main__":
    run_interactive_loop()`,
    startSandboxSh: `#!/usr/bin/env bash
set -euo pipefail
./scripts/build-sandbox.sh
docker run --rm --init \\
  --mount type=bind,source="$(pwd)/sandbox_workspace",target=/workspace \\
  --workdir /workspace \\
  --user 1000:1000 \\
  --cap-drop=ALL \\
  --security-opt=no-new-privileges:true \\
  --network=none \\
  --cpus=1.0 \\
  --memory=512m \\
  --memory-swap=512m \\
  --pids-limit=64 \\
  --read-only \\
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \\
  --tmpfs /home/sandbox:rw,nosuid,nodev,size=64m,uid=1000,gid=1000 \\
  nanogem-sandbox:latest /bin/bash -c "ls -la"`,
  };
  res.json(codebase);
});

// --- PROJECTS & SESSIONS ENDPOINTS ---

app.get("/api/projects", (_req, res) => {
  res.json({
    projects: projectStore.listProjects(),
    approvedRoot: projectStore.approvedRoot,
  });
});

app.post("/api/projects", (req, res) => {
  try {
    const { name, workspacePath } = req.body || {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Project name is required" });
    }
    if (workspacePath !== undefined && typeof workspacePath !== "string") {
      return res.status(400).json({ error: "workspacePath must be a string" });
    }

    const project = projectStore.createProject({ name, workspacePath });
    const session = sessionStore.ensureDefaultSession(project.id);
    res.status(201).json({ project, session });
  } catch (error: any) {
    const message = error?.message || "Failed to create project";
    const status = /Security Error|Invalid|conflicts/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

app.post("/api/projects/:projectId/select", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const defaultSession = sessionStore.ensureDefaultSession(project.id);
    const sessions = sessionStore.listSessions(project.id);
    const files = await getWorkspaceFilesTree(project.workspacePath);
    res.json({ project, defaultSession, sessions, files });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/sessions", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId.trim() : undefined;
  if (projectId && !projectStore.getProjectById(projectId)) {
    return res.status(404).json({ error: "Project not found" });
  }
  res.json({ sessions: sessionStore.listSessions(projectId) });
});

app.post("/api/sessions", (req, res) => {
  try {
    const { projectId = "default", title, model } = req.body || {};
    if (typeof projectId !== "string" || !projectId.trim()) {
      return res.status(400).json({ error: "projectId is required" });
    }
    if (!projectStore.getProjectById(projectId.trim())) {
      return res.status(404).json({ error: "Project not found" });
    }
    const session = sessionStore.createSession({
      projectId: projectId.trim(),
      title: typeof title === "string" ? title : undefined,
      model: typeof model === "string" ? model : undefined,
      channel: "browser",
    });
    res.status(201).json({ session, messages: [], events: [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/sessions/:sessionId", (req, res) => {
  try {
    const expectedProjectId =
      typeof req.query.projectId === "string" && req.query.projectId.trim()
        ? req.query.projectId.trim()
        : undefined;
    const details = sessionStore.getSessionDetails(req.params.sessionId, expectedProjectId);
    if (!details) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json(details);
  } catch (error: any) {
    if (/Security Error/i.test(error?.message || "")) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET Workspace File Tree
app.get("/api/workspace/files", async (req, res) => {
  try {
    const ctx = resolveProjectContext(req.query.projectId, req.query.sessionId);
    if (!ctx.project) {
      return res.status(ctx.errorStatus || 404).json({ error: ctx.errorMessage });
    }
    if (ctx.project.isDefault) {
      ensureWorkspace();
    }
    const tree = await getWorkspaceFilesTree(ctx.project.workspacePath);
    res.json({ files: tree, projectId: ctx.project.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET File Content
app.get("/api/workspace/file", async (req, res) => {
  try {
    const ctx = resolveProjectContext(req.query.projectId, req.query.sessionId);
    if (!ctx.project) {
      return res.status(ctx.errorStatus || 404).json({ error: ctx.errorMessage });
    }
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "Missing path query parameter" });

    const safePath = await projectStore.resolveProjectFile(ctx.project.id, filePath);
    if (!safePath) return res.status(403).json({ error: "Access denied" });

    const content = await fs.readFile(safePath, "utf-8");
    res.json({ path: filePath, content, projectId: ctx.project.id });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return res.status(404).json({ error: "File not found" });
    }
    if (error?.code === "EISDIR") {
      return res.status(400).json({ error: "Path is a directory" });
    }
    res.status(500).json({ error: error.message });
  }
});

// POST Save/Create File
app.post("/api/workspace/file", async (req, res) => {
  try {
    const { path: filePath, content, projectId, sessionId } = req.body || {};
    const ctx = resolveProjectContext(projectId, sessionId);
    if (!ctx.project) {
      return res.status(ctx.errorStatus || 404).json({ error: ctx.errorMessage });
    }
    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({ error: "Missing file path" });
    }
    if (content !== undefined && typeof content !== "string") {
      return res.status(400).json({ error: "File content must be a string" });
    }

    const safePath = await projectStore.resolveProjectFile(ctx.project.id, filePath);
    if (!safePath) {
      return res.status(403).json({ error: "Access denied" });
    }

    const writeResult = await writeWorkspaceFile(ctx.project.workspacePath, filePath, content ?? "");
    res.json({ result: writeResult.output, projectId: ctx.project.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE File
app.delete("/api/workspace/file", async (req, res) => {
  try {
    const ctx = resolveProjectContext(req.query.projectId, req.query.sessionId);
    if (!ctx.project) {
      return res.status(ctx.errorStatus || 404).json({ error: ctx.errorMessage });
    }
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "Missing file path" });

    const safePath = await projectStore.resolveProjectFile(ctx.project.id, filePath);
    if (!safePath) return res.status(403).json({ error: "Access denied" });

    await fs.rm(safePath, { recursive: true, force: true });
    res.json({ success: true, projectId: ctx.project.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST Run Manual Terminal Command
app.post("/api/workspace/terminal", async (req, res) => {
  try {
    const { command, projectId, sessionId } = req.body || {};
    const ctx = resolveProjectContext(projectId, sessionId);
    if (!ctx.project) {
      return res.status(ctx.errorStatus || 404).json({ error: ctx.errorMessage });
    }
    if (typeof command !== "string" || !command.trim()) {
      return res.status(400).json({ error: "Missing or invalid command" });
    }

    const projectSandbox = projectStore.buildSandboxConfigForProject(sandboxConfig, ctx.project.id);
    const output = await executeSandboxCommand(command, projectSandbox);
    res.json({ output, projectId: ctx.project.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST Reset Workspace
app.post("/api/workspace/reset", async (req, res) => {
  try {
    const { projectId } = req.body || {};
    const ctx = resolveProjectContext(projectId);
    if (!ctx.project) {
      return res.status(ctx.errorStatus || 404).json({ error: ctx.errorMessage });
    }
    await fs.rm(ctx.project.workspacePath, { recursive: true, force: true });
    if (ctx.project.isDefault) {
      ensureWorkspace();
    } else {
      await fs.mkdir(ctx.project.workspacePath, { recursive: true });
    }
    const tree = await getWorkspaceFilesTree(ctx.project.workspacePath);
    res.json({ message: "Workspace reset successfully", files: tree, projectId: ctx.project.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET Project Instructions (GEMINI.md) and Memory (MEMORY.md)
app.get("/api/projects/:projectId/context", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const loaded = await loadProjectInstructionsAndMemory(project.workspacePath);
    res.json({
      projectId: project.id,
      projectName: project.name,
      ...loaded,
      defaultGeminiTemplate: DEFAULT_GEMINI_MD_TEMPLATE,
      defaultMemoryTemplate: DEFAULT_MEMORY_MD_TEMPLATE,
      maxBytes: MAX_PROJECT_CONTEXT_BYTES,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT Project Instructions (GEMINI.md) or Memory (MEMORY.md)
app.put("/api/projects/:projectId/context", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const { kind, content } = req.body || {};
    if (kind !== "GEMINI.md" && kind !== "MEMORY.md") {
      return res.status(400).json({ error: "kind must be 'GEMINI.md' or 'MEMORY.md'" });
    }
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content must be a string" });
    }
    const saved = await saveProjectContextFile(project.workspacePath, kind, content);
    const loaded = await loadProjectInstructionsAndMemory(project.workspacePath);
    res.json({
      projectId: project.id,
      saved,
      ...loaded,
      maxBytes: MAX_PROJECT_CONTEXT_BYTES,
    });
  } catch (error: any) {
    const msg = error?.message || "Failed to save project context";
    const status = /exceeds|Security Error|must be/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

// POST Append curated entry to MEMORY.md (explicit user action)
app.post("/api/projects/:projectId/memory/append", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const { entry, sourceFile } = req.body || {};
    if (typeof entry !== "string" || !entry.trim()) {
      return res.status(400).json({ error: "Memory entry is required" });
    }
    if (sourceFile !== undefined && typeof sourceFile !== "string") {
      return res.status(400).json({ error: "sourceFile must be a string" });
    }
    const appended = await appendCuratedProjectMemory(project.workspacePath, entry, sourceFile);
    res.json({
      projectId: project.id,
      memoryMd: appended.content,
      bytes: appended.bytes,
      redactedCount: appended.redactedCount,
      maxBytes: MAX_PROJECT_CONTEXT_BYTES,
    });
  } catch (error: any) {
    const msg = error?.message || "Failed to append project memory";
    const status = /Security Error|exceed|empty/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

// --- GIT REVIEW & REVERT WORKFLOW ENDPOINTS ---

app.get("/api/projects/:projectId/git/status", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const status = await getGitStatus(project.workspacePath);
    res.json({ projectId: project.id, ...status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/projects/:projectId/git/diff", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const diff = await getGitDiff(project.workspacePath);
    res.json({ projectId: project.id, ...diff });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/projects/:projectId/git/branch", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const { branchName } = req.body || {};
    if (typeof branchName !== "string" || !branchName.trim()) {
      return res.status(400).json({ error: "branchName is required" });
    }
    const created = await createGitBranch(project.workspacePath, branchName);
    res.json({ projectId: project.id, ...created });
  } catch (error: any) {
    const msg = error?.message || "Failed to create branch";
    const status = /Invalid|not a Git/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/projects/:projectId/git/revert", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const { confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: "Explicit confirmation (confirm=true) is required before reverting workspace changes.",
      });
    }
    const result = await revertGitWorkspace(project.workspacePath, { confirm: true });
    res.json({ projectId: project.id, ...result });
  } catch (error: any) {
    const msg = error?.message || "Failed to revert workspace";
    const status = /confirmation|not a Git/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/projects/:projectId/git/commit", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const { message, confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: "Explicit confirmation (confirm=true) is required before committing changes.",
      });
    }
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Commit message is required" });
    }
    const result = await commitGitChanges(project.workspacePath, {
      message,
      confirm: true,
    });
    res.json({ projectId: project.id, ...result });
  } catch (error: any) {
    const msg = error?.message || "Failed to commit changes";
    const status = /confirmation|required|clean|not a Git/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

// --- OPT-IN SCHEDULED TASKS ENDPOINTS ---

app.get("/api/schedules", (req, res) => {
  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
  if (projectId && !projectStore.getProjectById(projectId)) {
    return res.status(404).json({ error: "Project not found" });
  }
  res.json({
    enabledByEnv: schedulerService.enabledByEnv,
    schedules: scheduleStore.listTasks(projectId),
    runs: scheduleStore.listRuns(projectId),
  });
});

app.post("/api/schedules", (req, res) => {
  try {
    const {
      projectId = "default",
      name,
      taskKind,
      scheduleExpr,
      promptOverride,
      enabled = false,
      notifyTelegramChatId,
    } = req.body || {};

    if (typeof projectId !== "string" || !projectStore.getProjectById(projectId)) {
      return res.status(404).json({ error: "Approved project not found" });
    }

    schedulerService.validateTelegramNotificationTarget(notifyTelegramChatId);

    const task = scheduleStore.createTask({
      projectId,
      name,
      taskKind,
      scheduleExpr,
      promptOverride: typeof promptOverride === "string" ? promptOverride : undefined,
      enabled: Boolean(enabled),
      notifyTelegramChatId:
        typeof notifyTelegramChatId === "string" ? notifyTelegramChatId : undefined,
    });
    res.status(201).json({ task });
  } catch (error: any) {
    const msg = error?.message || "Failed to create schedule";
    const status = /Invalid|required|Unsupported|Security Error|between|require/i.test(msg)
      ? 400
      : 500;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/schedules/:taskId/pause", (req, res) => {
  const task = scheduleStore.pauseTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: "Scheduled task not found" });
  res.json({ task });
});

app.post("/api/schedules/:taskId/resume", (req, res) => {
  const task = scheduleStore.resumeTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: "Scheduled task not found" });
  res.json({ task });
});

app.post("/api/schedules/:taskId/run-now", async (req, res) => {
  try {
    const existing = scheduleStore.getTaskById(req.params.taskId);
    if (!existing) return res.status(404).json({ error: "Scheduled task not found" });
    const run = await schedulerService.runTask(existing.id);
    res.json({ run, task: scheduleStore.getTaskById(existing.id) });
  } catch (error: any) {
    const msg = error?.message || "Failed to execute scheduled task";
    const status = /Concurrency Guard/i.test(msg) ? 409 : 500;
    res.status(status).json({ error: msg });
  }
});

app.delete("/api/schedules/:taskId", (req, res) => {
  const deleted = scheduleStore.deleteTask(req.params.taskId);
  if (!deleted) return res.status(404).json({ error: "Scheduled task not found" });
  res.json({ deleted: true });
});

// --- OPTIONAL PROJECT WORKFLOW TEMPLATES ---

app.get("/api/workflows/templates", (_req, res) => {
  res.json({
    templates: WORKFLOW_TEMPLATES,
    dataHandlingNotice: WORKFLOW_DATA_HANDLING_NOTICE,
  });
});

app.post("/api/projects/:projectId/workflows/run", async (req, res) => {
  try {
    const project = projectStore.getProjectById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const { templateId, goal = "", selectedFiles = [], confirmSendToGemini, sessionId } =
      req.body || {};

    const prepared = await prepareWorkflowPrompt({
      workspaceDir: project.workspacePath,
      templateId: String(templateId || ""),
      goal: typeof goal === "string" ? goal : "",
      selectedFiles: Array.isArray(selectedFiles) ? selectedFiles : [],
      confirmSendToGemini: confirmSendToGemini === true,
    });

    const payload = await executeProjectChatTurn({
      message: prepared.prompt,
      projectId: project.id,
      sessionId,
    });

    res.json({
      ...payload,
      workflow: {
        templateId: prepared.template.id,
        title: prepared.template.title,
        includedFiles: prepared.includedFiles,
        totalBytes: prepared.totalBytes,
      },
    });
  } catch (error: any) {
    const msg = error?.message || "Workflow failed";
    const status =
      typeof error?.statusCode === "number"
        ? error.statusCode
        : /Security Error/i.test(msg)
          ? 403
          : /Explicit confirmation|Unknown workflow|Unsupported file|Sensitive file|exceeds|must be/i.test(msg)
            ? 400
            : 500;
    res.status(status).json({ error: msg });
  }
});

async function executeProjectChatTurn(
  body: Record<string, unknown>,
  onProgress?: (event: ProgressEvent) => void | Promise<void>
) {
  const {
    message,
    history,
    model = DEFAULT_GEMINI_MODEL,
    temperature = 0,
    systemInstruction = DEFAULT_SYSTEM_INSTRUCTION,
    maxTurns,
    projectId,
    sessionId,
  } = body || {};

  if (!message || typeof message !== "string") {
    throw Object.assign(new Error("Message is required"), { statusCode: 400 });
  }

  const ctx = resolveProjectContext(projectId, sessionId);
  if (!ctx.project) {
    throw Object.assign(new Error(ctx.errorMessage || "Project not found"), {
      statusCode: ctx.errorStatus || 404,
    });
  }

  if (!agentProvider.isConfigured()) {
    throw Object.assign(new Error("GEMINI_API_KEY is not configured on the server."), {
      statusCode: 503,
    });
  }

  const activeSession = ctx.session ?? sessionStore.ensureDefaultSession(ctx.project.id);
  const persistedDetails = sessionStore.getSessionDetails(activeSession.id, ctx.project.id);
  const effectiveHistory = Array.isArray(history)
    ? history
    : (persistedDetails?.messages || []).map((m) => ({
        role: m.role,
        content: m.content,
      }));

  sessionStore.appendMessage({
    sessionId: activeSession.id,
    projectId: ctx.project.id,
    role: "user",
    content: message,
  });

  const projectSandbox = projectStore.buildSandboxConfigForProject(sandboxConfig, ctx.project.id);
  const projectCtx = await loadProjectInstructionsAndMemory(ctx.project.workspacePath);
  const baseSystemInstruction =
    typeof systemInstruction === "string" ? systemInstruction : DEFAULT_SYSTEM_INSTRUCTION;
  const effectiveSystemInstruction = buildProjectSystemInstruction({
    baseInstruction: baseSystemInstruction,
    projectName: ctx.project.name,
    geminiMd: projectCtx.geminiMd,
    memoryMd: projectCtx.memoryMd,
  });

  const progressStream = new AgentProgressStream();
  if (onProgress) {
    progressStream.subscribe(onProgress);
  }

  const result = await agentProvider.run({
    message,
    history: effectiveHistory,
    model: typeof model === "string" ? model : DEFAULT_GEMINI_MODEL,
    temperature: typeof temperature === "number" ? temperature : 0,
    systemInstruction: effectiveSystemInstruction,
    maxTurns: typeof maxTurns === "number" ? maxTurns : undefined,
    protectContextFiles: true,
    sandboxConfig: projectSandbox,
    onPhase: (phase, turn) => progressStream.handlePhase(phase, turn),
    onEvent: (event) => progressStream.handleAgentEvent(event),
  });

  sessionStore.appendMessage({
    sessionId: activeSession.id,
    projectId: ctx.project.id,
    role: "assistant",
    content: result.text,
    executionSteps: result.executionSteps,
  });
  sessionStore.appendExecutionEvents(activeSession.id, ctx.project.id, result.events);
  projectStore.touchProject(ctx.project.id);

  const updatedFiles = await getWorkspaceFilesTree(ctx.project.workspacePath);

  return {
    text: result.text,
    executionSteps: result.executionSteps,
    events: result.events,
    progressEvents: progressStream.getEvents(),
    turns: result.turns,
    maxTurnsReached: result.maxTurnsReached,
    files: updatedFiles,
    projectId: ctx.project.id,
    sessionId: activeSession.id,
  };
}

// POST Agent Chat endpoint (non-streaming JSON compatibility)
app.post("/api/agent/chat", async (req, res) => {
  try {
    const payload = await executeProjectChatTurn((req.body || {}) as Record<string, unknown>);
    res.json(payload);
  } catch (error: any) {
    const status = typeof error?.statusCode === "number" ? error.statusCode : 500;
    if (status >= 500) {
      console.error("Agent chat error:", error);
    }
    res.status(status).json({
      error: error.message || "Internal server error during agent execution.",
    });
  }
});

// POST Agent Chat SSE Stream endpoint
app.post("/api/agent/chat/stream", async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  if (!body.message || typeof body.message !== "string") {
    return res.status(400).json({ error: "Message is required" });
  }
  const preCheck = resolveProjectContext(body.projectId, body.sessionId);
  if (!preCheck.project) {
    return res.status(preCheck.errorStatus || 404).json({ error: preCheck.errorMessage });
  }
  if (!agentProvider.isConfigured()) {
    return res.status(503).json({
      error: `${agentProvider.displayName} API key is not configured on the server.`,
    });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let disconnected = false;
  req.on("close", () => {
    disconnected = true;
  });

  const writeSse = (eventName: string, data: unknown) => {
    if (disconnected || res.writableEnded || res.destroyed) return;
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const payload = await executeProjectChatTurn(body, (progressEvent) => {
      writeSse("progress", progressEvent);
    });
    writeSse("result", payload);
  } catch (error: any) {
    writeSse("error", {
      error: error?.message || "Internal server error during agent execution.",
    });
  } finally {
    if (!disconnected && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
});

// Return JSON 404 for unknown /api/* routes instead of falling through to SPA HTML.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

// Start Express / Vite Server
export async function startServer() {
  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
  const isDev = process.env.NODE_ENV !== "production";

  if (isDev) {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // In development preview mode, bind dual-stack "::" when NANOGEM_HOST is not explicitly pinned
  // so both IPv4 (127.0.0.1 / 0.0.0.0) and IPv6 (::1) readiness probes succeed while API auth
  // continues enforcing loopback-only remote addresses unless NANOGEM_API_TOKEN is set.
  const listenHost =
    isDev && !process.env.NANOGEM_HOST?.trim() ? "::" : securityConfig.host;

  const server = app.listen(securityConfig.port, listenHost, () => {
    console.log(
      `[NanoGem Server] Running on http://${securityConfig.host}:${securityConfig.port} ` +
        `(Local: http://localhost:${securityConfig.port}/, execution=${sandboxConfig.executionMode}, auth=${securityConfig.authRequired ? "enabled" : "loopback-only"})`
    );
    if (sandboxConfig.executionMode === "host") {
      console.warn(
        "[SECURITY WARNING] NANOGEM_EXECUTION_MODE=host is active. Commands run directly on the host without Docker isolation!"
      );
    } else {
      console.log(
        `[NanoGem Sandbox] runtime=${sandboxConfig.containerRuntime}, image=${sandboxConfig.dockerImage}, user=${sandboxConfig.dockerUser}, ` +
          `network=${sandboxConfig.dockerNetwork}, cpus=${sandboxConfig.dockerCpus}, ` +
          `memory=${sandboxConfig.dockerMemory}, pids=${sandboxConfig.dockerPidsLimit}`
      );
    }
  });

  if (telegramConfig.enabled && telegramConfig.polling) {
    void telegramAdapter.startPolling();
  }
  schedulerService.start();

  const shutdown = () => {
    schedulerService.stop();
    void telegramAdapter.stop().catch(() => {});
    if (vite) {
      void vite.close().catch(() => {});
    }
    server.closeAllConnections?.();
    server.close(() => {
      try {
        db.close();
      } catch {
        // Ignore if already closed
      }
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return server;
}

if (process.env.NANOGEM_SKIP_LISTEN !== "1") {
  startServer();
}

export { app, sandboxConfig, securityConfig };
