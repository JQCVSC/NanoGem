![NanoGemini Banner](https://i.imgur.com/yAe5JTL.jpeg)

# NanoGem

**A highly-secure, Docker-sandboxed AI agent runtime built natively for Google Gemini.**

NanoGemini is an ultra-lightweight, auditable AI-assistant harness. It gives Gemini 2.5 Flash and Pro models the ability to execute code, manage files, and run terminal commands autonomously—but **strictly inside an isolated Linux container.** 

If the agent accidentally runs `rm -rf /`, it only destroys a temporary sandbox, not your host machine.

---

## 📖 Core Philosophy

* **Gemini-Native.** Built specifically to exploit Gemini's massive 2-million token context window and native multimodal (vision/audio) capabilities. No RAG or vector DBs required—just feed it entire codebases.
* **Secure by Isolation.** Agents do not run on your host machine. They run in ephemeral Docker containers. They can only see the workspace directories you explicitly mount.
* **Small Enough to Understand.** One core Python process. No microservices. The entire codebase is small enough that you can ask Gemini to read and explain it to you in one prompt.
* **Destructive Freedom.** Because the agent is sandboxed, you can give it unrestricted `bash` access to build apps, install dependencies, and debug its own code without fear.

---

## 🏗️ Architecture

NanoGemini uses a simple "Host ↔ Container" model. The host machine runs the setup script and Docker daemon, while the Gemini API execution loop runs entirely inside the sandbox.

```text
nanogemini/
├── Dockerfile             # The secure Debian-based sandbox definition
├── requirements.txt       # Sandbox dependencies (google-genai, etc.)
├── agent.py               # The core agent loop running inside Docker
├── tools.py               # Function Call mappings (bash execution, file I/O)
└── start_sandbox.sh       # Host script to mount volumes and launch the agent
```

---

## ✨ Key Features

- **Perfect Recall Memory:** Utilize Gemini's massive context window to load entire projects into MEMORY.md.
- **True Sandbox Execution:** `execute_system_command` runs directly in the container, meaning the agent can safely run npm install, compile code, or test bash scripts.
- **Restricted File I/O:** The `write_local_file` tool automatically restricts the agent's reach to a mounted `/workspace/` directory, preventing directory traversal attacks.
- **Flash Economics:** Powered by `gemini-2.5-flash` by default for ultra-fast, low-cost autonomous background loops.

---

## 🚀 Quick Start

### Prerequisites
- macOS or Linux (Windows via WSL2)
- Docker installed and running
- A Google Gemini API Key (Get one from Google AI Studio)

### 1. Clone & Configure
```bash
git clone https://github.com/JQCVSC/NanoGem.git
cd nanogemini

# Create your environment file
echo "GEMINI_API_KEY=your_api_key_here" > .env
```

### 2. Start the Sandbox
Run the host startup script. This will build the Docker container and mount a local folder (`./my_local_workspace`) from your machine into the container's `/workspace`.

```bash
chmod +x start_sandbox.sh
./start_sandbox.sh
```

### 3. Talk to NanoGemini
Once the container starts, you will drop into an interactive prompt. Try asking the agent to build something:

> **[You]:** Create a new React project in this folder, install tailwindcss, and configure the tailwind.config.js file for me.

Watch as NanoGemini executes the terminal commands inside the container, and the files appear instantly in your host's `./my_local_workspace` folder!

---

## 🧠 Advanced Usage: Customizing the "Soul"

NanoGemini's personality and operational rules are defined by its System Instructions. You can modify these directly in `agent.py`:

```python
SYSTEM_INSTRUCTION = """
You are NanoGemini, a senior security engineer.
Your working directory is restricted to `/workspace/`. 
Do not ask for permission before running bash commands to audit code.
Always think step-by-step and write a summary to `audit_report.md` when finished.
"""
```

---

## 🛡️ Security Disclaimer

While NanoGemini runs inside a Docker container, Docker is not a perfect security boundary against dedicated malicious actors (container escape vulnerabilities exist).

* Do not mount sensitive host directories (like `~/.ssh/` or `/etc/`) into the container.
* Do not pass your primary AWS/GCP root credentials as environment variables to the sandbox.

---

## 🤝 Contributing

We welcome contributions! Whether it's adding new multimodal tools (like allowing the agent to "see" screenshots of the UI it just built) or optimizing the Docker build, feel free to submit a PR.

---

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.
