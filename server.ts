import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";
import { createServer as createViteServer } from "vite";
import {
  applySecurityHeaders,
  createApiAuthMiddleware,
  loadServerSecurityConfig,
} from "./src/server/auth.ts";
import {
  checkDockerAvailability,
  executeSandboxCommand,
  loadSandboxConfig,
  resolveSafeWorkspacePath,
} from "./src/server/sandboxRuntime.ts";

const app = express();

app.disable("x-powered-by");
app.use(applySecurityHeaders);
app.use(express.json({ limit: "10mb" }));

// 1. Initialize Gemini Client
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("GEMINI_API_KEY environment variable is not set.");
  }
  return new GoogleGenAI({
    apiKey: apiKey || "",
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
};

// 2. Setup Sandbox Workspace Directory & Runtime Configuration
const WORKSPACE_DIR = path.resolve(process.cwd(), "sandbox_workspace");
const sandboxConfig = loadSandboxConfig(WORKSPACE_DIR);
const securityConfig = loadServerSecurityConfig();

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

// Helper for security path checking
async function resolveSafePath(filePath: string): Promise<string | null> {
  return resolveSafeWorkspacePath(WORKSPACE_DIR, filePath);
}

// 3. Workspace Utility Functions
async function executeSystemCommand(command: string): Promise<string> {
  return executeSandboxCommand(command, sandboxConfig);
}

async function writeLocalFile(filePath: string, content: string): Promise<string> {
  const safePath = await resolveSafePath(filePath);
  if (!safePath) {
    return "Security Error: Cannot write files outside of /workspace/";
  }
  try {
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, content, "utf-8");
    const relativePath = path.relative(WORKSPACE_DIR, safePath);
    return `Success: Wrote to /workspace/${relativePath}`;
  } catch (error: any) {
    return `Error writing file: ${error.message}`;
  }
}

async function getWorkspaceFilesTree(dir = WORKSPACE_DIR, relative = ""): Promise<any[]> {
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

// 4. Gemini Function Declarations for NanoGemini Agent
const agentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: "execute_system_command",
    description:
      "Executes a bash terminal command in the /workspace/ directory and returns the console output.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: "The bash command to run (e.g., 'npm init -y', 'python app.py', or 'ls -la')",
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

// --- REST API ENDPOINTS ---

// Healthcheck
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    executionMode: sandboxConfig.executionMode,
    authRequired: securityConfig.authRequired,
  });
});

// Runtime sandbox posture & Docker status
app.get("/api/runtime/status", async (req, res) => {
  const docker =
    sandboxConfig.executionMode === "docker"
      ? await checkDockerAvailability(sandboxConfig)
      : null;

  res.json({
    executionMode: sandboxConfig.executionMode,
    authRequired: securityConfig.authRequired,
    docker:
      sandboxConfig.executionMode === "docker"
        ? {
            image: sandboxConfig.dockerImage,
            user: sandboxConfig.dockerUser,
            network: sandboxConfig.dockerNetwork,
            cpus: sandboxConfig.dockerCpus,
            memory: sandboxConfig.dockerMemory,
            pidsLimit: sandboxConfig.dockerPidsLimit,
            readOnly: sandboxConfig.dockerReadOnly,
            ...docker,
          }
        : null,
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

// GET Workspace File Tree
app.get("/api/workspace/files", async (req, res) => {
  try {
    ensureWorkspace();
    const tree = await getWorkspaceFilesTree();
    res.json({ files: tree });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET File Content
app.get("/api/workspace/file", async (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "Missing path query parameter" });

    const safePath = await resolveSafePath(filePath);
    if (!safePath) return res.status(403).json({ error: "Access denied" });

    const content = await fs.readFile(safePath, "utf-8");
    res.json({ path: filePath, content });
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
    const { path: filePath, content } = req.body;
    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({ error: "Missing file path" });
    }
    if (content !== undefined && typeof content !== "string") {
      return res.status(400).json({ error: "File content must be a string" });
    }

    const safePath = await resolveSafePath(filePath);
    if (!safePath) {
      return res.status(403).json({ error: "Access denied" });
    }

    const result = await writeLocalFile(filePath, content ?? "");
    res.json({ result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE File
app.delete("/api/workspace/file", async (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "Missing file path" });

    const safePath = await resolveSafePath(filePath);
    if (!safePath) return res.status(403).json({ error: "Access denied" });

    await fs.rm(safePath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST Run Manual Terminal Command
app.post("/api/workspace/terminal", async (req, res) => {
  try {
    const { command } = req.body;
    if (typeof command !== "string" || !command.trim()) {
      return res.status(400).json({ error: "Missing or invalid command" });
    }

    const output = await executeSystemCommand(command);
    res.json({ output });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST Reset Workspace
app.post("/api/workspace/reset", async (req, res) => {
  try {
    await fs.rm(WORKSPACE_DIR, { recursive: true, force: true });
    ensureWorkspace();
    const tree = await getWorkspaceFilesTree();
    res.json({ message: "Workspace reset successfully", files: tree });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST Agent Chat endpoint with Autonomous Function Calling Loop
app.post("/api/agent/chat", async (req, res) => {
  try {
    const {
      message,
      history = [],
      model = "gemini-3.6-flash",
      systemInstruction = `You are NanoGemini, an autonomous developer agent running inside a secure, isolated Docker sandbox.
You have the ability to execute bash terminal commands and write files directly to the file system.
Your working directory is restricted to \`/workspace/\`. 
If a user asks you to build an app or run a script, create the files, install dependencies via bash, run commands, and verify it works.
Always think step-by-step. Use your tools immediately when needed without asking for permission.`,
    } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim() || "";
    const placeholderKeys = new Set(["MY_GEMINI_API_KEY", "your_gemini_api_key_here"]);
    if (!apiKey || placeholderKeys.has(apiKey)) {
      return res.status(503).json({
        error: "GEMINI_API_KEY is not configured on the server.",
      });
    }

    const safeHistory = Array.isArray(history) ? history : [];
    const ai = getGeminiClient();

    // Prepare contents history
    // We construct the contents array for generateContent or chat session
    const contents: any[] = [];

    // Format previous turns
    for (const item of safeHistory) {
      if (item && typeof item.role === "string" && typeof item.content === "string") {
        contents.push({
          role: item.role === "user" ? "user" : "model",
          parts: [{ text: item.content }],
        });
      }
    }

    // Add current user prompt
    contents.push({
      role: "user",
      parts: [{ text: message }],
    });

    const executionSteps: Array<{
      type: "tool_call" | "text_response";
      toolName?: string;
      args?: any;
      output?: string;
      text?: string;
    }> = [];

    let currentTurnCount = 0;
    const maxTurns = 8; // Prevent infinite tool loops
    let finalText = "";

    let currentContents = [...contents];

    while (currentTurnCount < maxTurns) {
      currentTurnCount++;

      const response = await ai.models.generateContent({
        model: model,
        contents: currentContents,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0,
          tools: [{ functionDeclarations: agentFunctionDeclarations }],
        },
      });

      const candidate = response.candidates?.[0];
      if (!candidate) {
        finalText = response.text || "No response candidate generated.";
        break;
      }

      const functionCalls = response.functionCalls;

      if (functionCalls && functionCalls.length > 0) {
        // Model requested one or more tool calls
        const functionResponsesParts: any[] = [];

        // Append model's candidate content to preserve context
        if (candidate.content) {
          currentContents.push(candidate.content);
        }

        for (const call of functionCalls) {
          const fnName = call.name;
          const fnArgs = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;

          let toolResult = "";
          if (fnName === "execute_system_command") {
            toolResult =
              typeof fnArgs.command === "string"
                ? await executeSystemCommand(fnArgs.command)
                : "Error: Invalid arguments for execute_system_command (expected string 'command').";
          } else if (fnName === "write_local_file") {
            toolResult =
              typeof fnArgs.file_path === "string" && typeof fnArgs.content === "string"
                ? await writeLocalFile(fnArgs.file_path, fnArgs.content)
                : "Error: Invalid arguments for write_local_file (expected string 'file_path' and 'content').";
          } else {
            toolResult = `Unknown function: ${fnName}`;
          }

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

        // Add function response turn back to contents
        currentContents.push({
          role: "user",
          parts: functionResponsesParts,
        });
      } else {
        // No function calls, model returned final text answer
        finalText = response.text || "";
        executionSteps.push({
          type: "text_response",
          text: finalText,
        });
        break;
      }
    }

    // Get updated workspace files to send back to UI
    const updatedFiles = await getWorkspaceFilesTree();

    res.json({
      text: finalText,
      executionSteps,
      files: updatedFiles,
    });
  } catch (error: any) {
    console.error("Agent chat error:", error);
    res.status(500).json({
      error: error.message || "Internal server error during agent execution.",
    });
  }
});

// Return JSON 404 for unknown /api/* routes instead of falling through to SPA HTML.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

// Start Express / Vite Server
export async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
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

  return app.listen(securityConfig.port, securityConfig.host, () => {
    console.log(
      `[NanoGemini Server] Running on http://${securityConfig.host}:${securityConfig.port} ` +
        `(execution=${sandboxConfig.executionMode}, auth=${securityConfig.authRequired ? "enabled" : "loopback-only"})`
    );
    if (sandboxConfig.executionMode === "host") {
      console.warn(
        "[SECURITY WARNING] NANOGEM_EXECUTION_MODE=host is active. Commands run directly on the host without Docker isolation!"
      );
    } else {
      console.log(
        `[NanoGemini Sandbox] Docker image=${sandboxConfig.dockerImage}, user=${sandboxConfig.dockerUser}, ` +
          `network=${sandboxConfig.dockerNetwork}, cpus=${sandboxConfig.dockerCpus}, ` +
          `memory=${sandboxConfig.dockerMemory}, pids=${sandboxConfig.dockerPidsLimit}`
      );
    }
  });
}

if (process.env.NANOGEM_SKIP_LISTEN !== "1") {
  startServer();
}

export { app, sandboxConfig, securityConfig };
