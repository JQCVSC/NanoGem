![NanoGemini Banner](https://i.imgur.com/yAe5JTL.jpeg)

# NanoGem

**A Gemini-native coding agent for local projects, with a boundary around autonomous execution.**

NanoGem runs Google Gemini (`@google/genai`) coding workflows from a browser workbench and an optional host-side Telegram channel while isolating file writes and shell execution inside an ephemeral, resource-bounded Docker container by default (`NANOGEM_EXECUTION_MODE=docker`).

---

## Architecture

1. **Browser Workbench & REST/SSE API (`server.ts`, `src/App.tsx`, `src/components/`)**:
   - Multi-project & multi-session workspace UI with live Server-Sent Events progress (`POST /api/agent/chat/stream`) and non-streaming JSON compatibility (`POST /api/agent/chat`).
   - Setup & readiness dashboard (`SetupStatusPanel`), `GEMINI.md` / `MEMORY.md` editor (`ProjectContextPanel`), Git review & revert (`GitReviewPanel`), opt-in scheduled tasks (`SchedulesPanel`), and research/data workflow templates (`WorkflowsPanel`).
2. **Gemini Agent & Provider Seam (`src/agent/`)**:
   - `agentService.ts`: Reusable `@google/genai` tool-calling loop (`execute_system_command`, `write_local_file`), maximum-turn guard, and structured lifecycle events.
   - `provider.ts`: Internal `AgentProvider` abstraction with Google Gemini (`"gemini"`) as the default and only enabled production provider.
   - `projectContext.ts`: Per-project `GEMINI.md` & `MEMORY.md` loader/saver with 16 KiB size bounds, secret redaction, `.env`/key import blocking, and protection against silent model overwrites.
   - `progressStream.ts`: Channel-agnostic progress events with command/secret sanitization.
3. **Hardened Docker Sandbox (`src/server/sandboxRuntime.ts`, `Dockerfile`, `scripts/build-sandbox.sh`)**:
   - `NANOGEM_EXECUTION_MODE=docker` by default (fail-closed; never falls back to host execution).
   - Mounts **only** the active project's workspace at `/workspace`.
   - Non-root user (`sandbox`, UID/GID `1000:1000`), `--cap-drop=ALL`, `--security-opt=no-new-privileges:true`, `--read-only` rootfs with bounded `tmpfs`, `--network=none`, `--cpus=1.0`, `--memory=512m`, `--pids-limit=64`, timeout cleanup (`docker rm -f`), and stripped host secrets.
4. **Persistent SQLite Storage (`src/storage/`)**:
   - Built on Node's `node:sqlite` (`database.ts`, `projectStore.ts`, `sessionStore.ts`, `telegramMappingStore.ts`, `scheduleStore.ts`).
   - Enforces approved-root project paths (`NANOGEM_PROJECTS_ROOT`), cross-project session isolation, and zero credential storage in SQLite.
5. **Safe Git Review (`src/git/gitReviewService.ts`)**:
   - Status, diff, validated branch creation, confirmation-gated revert and local commit, non-Git workspace compatibility, and no remote `git push` or host SSH key exposure.
6. **Host-Side Telegram Channel & Opt-In Scheduler (`src/channels/telegram/`, `src/scheduler/`)**:
   - `grammy` long-polling adapter (with `webhookCallback` seam) using fail-closed user/chat allowlists and isolated per-chat projects.
   - Opt-in recurring test, repo-status, and dependency-check schedules (`NANOGEM_SCHEDULES_ENABLED=true`) with per-project concurrency locks and crash/restart recovery.

---

## Repository Structure

```text
NanoGem/
├── Dockerfile                         # Canonical non-root sandbox image (Node 22 + Python 3 + Git)
├── .dockerignore                      # Excludes host secrets, node_modules, DBs, and workspaces
├── .github/workflows/docker-sandbox.yml # Buildx build, hardened smoke test, artifact & GHCR publish
├── scripts/build-sandbox.sh           # Local sandbox image builder
├── server.ts                          # Express + Vite server, REST/SSE APIs, auth & channel wiring
├── src/
│   ├── agent/                         # Agent loop, provider seam, project context, progress stream
│   ├── channels/telegram/             # Host-side Telegram adapter, config & formatting
│   ├── git/                           # Safe Git status/diff/branch/revert/commit service
│   ├── scheduler/                     # Cron/interval parser and concurrency-guarded scheduler
│   ├── server/                        # Auth middleware, loopback guards & Docker sandbox runtime
│   ├── storage/                       # SQLite migrations and project/session/schedule stores
│   ├── workflows/                     # Optional research/doc/CSV/Python workflow templates
│   └── components/                    # React workbench UI panels
├── sandbox_workspace/                 # Default migrated project workspace
├── tests/                             # Unit and built-server smoke tests
├── .env.example                       # Complete environment template with safe defaults
├── README.md
├── SECURITY.md                        # Threat model, isolation controls & disclosure process
└── WEBSITE_COPY.md                    # Verified product positioning copy
```

---

## Quick Start

### Prerequisites
- Node.js 20+ (tested on Node 26 with built-in `node:sqlite`) and npm
- Docker or Podman installed and running at runtime (required for default `docker` execution mode, even when using a prebuilt CI image)
- A Google Gemini API Key

### 1. Install Dependencies & Obtain the Sandbox Image
```bash
git clone https://github.com/JQCVSC/NanoGem.git
cd NanoGem

npm ci
```

Obtain `nanogem-sandbox` using one of these options (note: CI builds remove the need to build locally, **not** the need for Docker/Podman at runtime):

- **Option A — Pull prebuilt image from GHCR (recommended):**
  GitHub Actions (`.github/workflows/docker-sandbox.yml`) builds `Dockerfile` with Buildx, runs hardened container smoke tests, and on `main` publishes `ghcr.io/jqcvsc/nanogem-sandbox` with both `sha-<full-commit-sha>` and `latest`.
  - **Repeatable / production setups (recommended):** pin an immutable commit tag:
    ```bash
    docker pull ghcr.io/jqcvsc/nanogem-sandbox:sha-<full-commit-sha>
    ```
    Set `NANOGEM_SANDBOX_IMAGE=ghcr.io/jqcvsc/nanogem-sandbox:sha-<full-commit-sha>` in `.env`.
  - **Local development convenience:** track `latest`:
    ```bash
    docker pull ghcr.io/jqcvsc/nanogem-sandbox:latest
    ```
    Set `NANOGEM_SANDBOX_IMAGE=ghcr.io/jqcvsc/nanogem-sandbox:latest` in `.env`.
- **Option B — Download GitHub Actions artifact:**
  Download `nanogem-sandbox-image` (`nanogem-sandbox-latest.tar.gz`) from **Actions → Build Sandbox Docker Image** on `https://github.com/JQCVSC/NanoGem` and run:
  ```bash
  docker load < nanogem-sandbox-latest.tar.gz
  ```
- **Option C — Build locally:**
  ```bash
  chmod +x scripts/build-sandbox.sh
  ./scripts/build-sandbox.sh
  ```

> **Security Warning:** Never mount or expose `/var/run/docker.sock` into the sandbox container.

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env and set GEMINI_API_KEY (and NANOGEM_SANDBOX_IMAGE if using GHCR)
```

### 3. Lint, Build, Test, and Run
```bash
npm run lint
npm run build
node --test tests/*.test.ts
npm start
```

For local UI development with Vite HMR:
```bash
npm run dev
```

By default, NanoGem binds only to loopback (`http://127.0.0.1:3000`).

---

## Browser Workflow

1. Open `http://127.0.0.1:3000` and review the **Setup & Status** tab to confirm Docker readiness and `GEMINI_API_KEY` status.
2. Create or select an isolated project in the top bar (stored under `NANOGEM_PROJECTS_ROOT`; `./sandbox_workspace` is migrated as the default project).
3. Optionally author project rules in `GEMINI.md` or curate notes in `MEMORY.md` under **Instructions & Memory** (or click **Save to Project Memory** on an assistant reply).
4. Send prompts in **Agent Chat** and watch live SSE progress (`Analyzing request` → `Calling Gemini` → `Running command` → `Command completed` → `Reviewing changes` → `Finished`).
5. Inspect diffs, create branches, revert (with confirmation), or commit locally in **Review Changes**.

---

## Telegram Setup (Host-Side Adapter)

Telegram runs inside the NanoGem host Node process via long polling—no public HTTPS endpoint is required, and `TELEGRAM_BOT_TOKEN` is never sent into Docker containers.

1. Create a bot via `@BotFather` and note your numeric Telegram user ID.
2. Configure `.env`:
   ```env
   TELEGRAM_BOT_TOKEN="your_bot_token"
   TELEGRAM_ALLOWED_USER_IDS="123456789"
   TELEGRAM_ALLOWED_CHAT_IDS=""
   TELEGRAM_REQUIRE_MENTION="true"
   TELEGRAM_POLLING="true"
   ```
3. Start NanoGem (`npm start`).
4. In Telegram, send `/start`, `/help`, `/new`, `/reset`, `/status`, or an authorized prompt. In group chats, mention `@your_bot_username` when `TELEGRAM_REQUIRE_MENTION="true"`.

Each Telegram chat maps to its own dedicated project and workspace in SQLite (`telegram_chat_mappings`) and never shares the browser's `default` workspace implicitly.

---

## Scheduled Tasks (Opt-In)

Scheduled tasks are **disabled by default** (`NANOGEM_SCHEDULES_ENABLED="false"`). To enable recurring checks (`test_run`, `repo_status`, `dependency_report`):

1. Set `NANOGEM_SCHEDULES_ENABLED="true"` in `.env` and restart NanoGem.
2. Open the **Schedules** tab, choose an approved project, enter an interval (`15m`, `1h`) or 5-field cron (`*/15 * * * *`), and optionally attach an allowlisted `notifyTelegramChatId`.
3. Use **Pause**, **Resume**, **Run Now**, or **Delete** as needed. Concurrency locks prevent overlapping scheduled runs on the same project workspace.

---

## Gemini API Data-Handling Limitation

NanoGem executes commands and stores SQLite sessions/files locally on your machine, **but it is not an offline or zero-egress system**. Prompts, conversation history, loaded `GEMINI.md` / `MEMORY.md` context, and any files explicitly confirmed in the **Workflows** tab are transmitted to the **Google Gemini API** for processing by Google. Never store credentials or `.env` secrets inside `GEMINI.md`, `MEMORY.md`, or uploaded workflow files.

---

## Safe Deployment Guidance

- Keep `HOST="127.0.0.1"` for local single-user use.
- If binding beyond loopback (`HOST="0.0.0.0"`), NanoGem refuses to start unless `NANOGEM_API_TOKEN` is set to a strong non-placeholder secret (`>= 16` chars). Always place a TLS-terminating reverse proxy in front of non-loopback binds.
- Keep `NANOGEM_EXECUTION_MODE="docker"` and `NANOGEM_DOCKER_NETWORK="none"` unless package downloads inside the sandbox are explicitly required.
- Only use `NANOGEM_EXECUTION_MODE="host"` for trusted local development when no container runtime is available:
  ```bash
  NANOGEM_EXECUTION_MODE=host npm start
  ```

---

## Troubleshooting

- **"Docker CLI ('docker') was not found" / "Docker Not Ready"**: Install and start Docker Desktop, Docker Engine, or Podman, then pull (`docker pull ...`) or build (`./scripts/build-sandbox.sh`) the configured `NANOGEM_SANDBOX_IMAGE`.
- **"GEMINI_API_KEY is not configured"**: Replace the placeholder value in `.env` with a valid Gemini API key and restart the server.
- **"Unauthorized (401)" in the UI**: Click **Token** in the header and paste the `NANOGEM_API_TOKEN` configured on the server.
- **Telegram bot ignores messages**: Verify your numeric user ID is listed in `TELEGRAM_ALLOWED_USER_IDS` (empty allowlists fail closed) and, in group chats, include `@bot_username` when `TELEGRAM_REQUIRE_MENTION="true"`.

---

## Configuration Reference

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | _(required for agent)_ | Google Gemini API key (server-only; never passed to sandbox) |
| `NANOGEM_PROVIDER` | `gemini` | Agent provider (`"gemini"` is the only enabled provider) |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` requires `NANOGEM_API_TOKEN`) |
| `PORT` | `3000` | HTTP server port |
| `NANOGEM_API_TOKEN` | `""` | Bearer / `X-NanoGem-Token` auth secret (`>= 16` chars for public bind) |
| `NANOGEM_EXECUTION_MODE` | `docker` | `"docker"` (default, fail-closed) or explicit `"host"` (local dev only) |
| `NANOGEM_SANDBOX_IMAGE` | `nanogem-sandbox:latest` | Sandbox image (`ghcr.io/jqcvsc/nanogem-sandbox:sha-<commit>` recommended; `NANOGEM_DOCKER_IMAGE` alias supported) |
| `NANOGEM_DOCKER_USER` | `1000:1000` | Non-root UID:GID (`0` / `root` rejected) |
| `NANOGEM_DOCKER_NETWORK` | `none` | Container network mode (`none` disables networking) |
| `NANOGEM_DOCKER_CPUS` | `1.0` | CPU quota (`--cpus`) |
| `NANOGEM_DOCKER_MEMORY` | `512m` | Memory/swap ceiling (`--memory`, `--memory-swap`) |
| `NANOGEM_DOCKER_PIDS_LIMIT` | `64` | Process limit (`--pids-limit`) |
| `NANOGEM_DOCKER_READ_ONLY` | `true` | Read-only container rootfs with bounded `tmpfs` |
| `NANOGEM_COMMAND_TIMEOUT_MS` | `30000` | Per-command timeout in milliseconds |
| `NANOGEM_MAX_OUTPUT_BYTES` | `1048576` | Max stdout/stderr buffer per command (1 MiB) |
| `NANOGEM_DB_PATH` | `.nanogem/nanogem.db` | SQLite database path |
| `NANOGEM_PROJECTS_ROOT` | `nanogem_workspaces` | Approved root directory for isolated projects |
| `NANOGEM_SCHEDULES_ENABLED` | `false` | Opt-in toggle for background scheduled tasks |
| `TELEGRAM_BOT_TOKEN` | `""` | Telegram bot token (host-side only; never passed to sandbox) |
| `TELEGRAM_ALLOWED_USER_IDS` | `""` | Comma-separated numeric Telegram user IDs (fail-closed if empty) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `""` | Optional comma-separated numeric chat ID allowlist |
| `TELEGRAM_REQUIRE_MENTION` | `true` | Require `@bot_username` mention in group/supergroup chats |
| `TELEGRAM_POLLING` | `true` | Enable Telegram long polling when `TELEGRAM_BOT_TOKEN` is set |
