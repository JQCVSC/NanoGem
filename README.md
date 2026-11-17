![NanoGemini Banner](https://i.imgur.com/yAe5JTL.jpeg)

# NanoGem

**A Docker-sandboxed AI agent runtime and web workbench built natively for Google Gemini.**

NanoGem gives Gemini models the ability to write files and execute terminal commands inside an isolated, resource-bounded Linux container by default—mounting **only** `./sandbox_workspace` at `/workspace`.

---

## Architecture

NanoGem consists of:
1. **Express + Vite Web Workbench (`server.ts`, `src/`)**: Serves the React UI, manages `/workspace` file operations safely, runs the Gemini tool-calling loop on the server, and enforces API authentication when exposed beyond loopback.
2. **Hardened Docker Sandbox Runtime (`src/server/sandboxRuntime.ts`, `Dockerfile`, `scripts/build-sandbox.sh`)**: Runs every agent and terminal command in an ephemeral Docker container with:
   - Docker execution **enabled by default** (`NANOGEM_EXECUTION_MODE=docker`)
   - Only `./sandbox_workspace` bind-mounted at `/workspace`
   - Non-root user (`sandbox`, UID/GID `1000:1000` by default; root/UID `0` rejected)
   - `--cap-drop=ALL` and `--security-opt=no-new-privileges:true`
   - Read-only container root filesystem (`--read-only`) with bounded `tmpfs` for `/tmp` and `/home/sandbox`
   - Network disabled by default (`--network=none`)
   - Strict CPU (`--cpus=1.0`), memory (`--memory=512m`, `--memory-swap=512m`), process (`--pids-limit=64`), and timeout limits
   - Host secrets (`GEMINI_API_KEY`, `NANOGEM_API_TOKEN`) stripped and never injected into the sandbox

```text
NanoGem/
├── Dockerfile                    # Hardened non-root sandbox image (Node 22 + Python 3 + Git)
├── .dockerignore                 # Excludes host secrets, node_modules, and workspace from image context
├── scripts/
│   └── build-sandbox.sh          # Builds the nanogem-sandbox:latest Docker image
├── server.ts                     # Express + Vite server & Gemini agent tool-calling loop
├── src/
│   ├── server/
│   │   ├── sandboxRuntime.ts     # Docker sandbox runner, explicit host fallback, path safety
│   │   └── auth.ts               # Loopback guard & Bearer/header token authentication
│   ├── api.ts                    # Authenticated frontend fetch helper
│   └── components/               # React UI (Chat, Workspace Files, Terminal, Export)
├── sandbox_workspace/            # Only host directory mounted at /workspace inside containers
├── .env.example                  # Environment configuration template
├── README.md
└── SECURITY.md                   # Threat model, isolation controls, and deployment guidance
```

---

## Quick Start

### Prerequisites
- Node.js 20+ and npm
- Docker or Podman installed and running at runtime (required for default `docker` execution mode, even when using a prebuilt CI image)
- A Google Gemini API Key

### 1. Install Dependencies & Obtain the Sandbox Image
```bash
git clone https://github.com/JQCVSC/NanoGem.git
cd NanoGem

npm ci
```

You can obtain the sandbox image in three ways. **Note:** Using a prebuilt image from GitHub Actions or GHCR removes the need to build the image locally, but **does not remove the need for Docker or Podman at runtime** when `NANOGEM_EXECUTION_MODE=docker`.

#### Option A: Pull the prebuilt image from GHCR (recommended)
GitHub Actions (`.github/workflows/docker-sandbox.yml`) automatically builds `Dockerfile` with Buildx, runs hardened container smoke tests, and on `main` pushes images to `ghcr.io/jqcvsc/nanogem-sandbox` tagged with both `sha-<full-commit-sha>` and `latest`.

- **Recommended for repeatable / production setups** — pin an immutable commit tag:
  ```bash
  docker pull ghcr.io/jqcvsc/nanogem-sandbox:sha-<full-commit-sha>
  ```
  Then set in `.env`:
  ```env
  NANOGEM_SANDBOX_IMAGE=ghcr.io/jqcvsc/nanogem-sandbox:sha-<full-commit-sha>
  ```
- **Convenient for development** — track the moving `latest` tag:
  ```bash
  docker pull ghcr.io/jqcvsc/nanogem-sandbox:latest
  ```
  Then set `NANOGEM_SANDBOX_IMAGE=ghcr.io/jqcvsc/nanogem-sandbox:latest` in `.env`.

#### Option B: Download the GitHub Actions workflow artifact
Every run of the **Build Sandbox Docker Image** workflow uploads `nanogem-sandbox-image` (`nanogem-sandbox-latest.tar.gz`) as a downloadable artifact:
1. Open **Actions → Build Sandbox Docker Image** on `https://github.com/JQCVSC/NanoGem` and download `nanogem-sandbox-image`.
2. Load it into your local container runtime:
   ```bash
   docker load < nanogem-sandbox-latest.tar.gz
   ```
   (This loads `nanogem-sandbox:latest`, matching the default `NANOGEM_SANDBOX_IMAGE`.)

#### Option C: Build locally
```bash
chmod +x scripts/build-sandbox.sh
./scripts/build-sandbox.sh
```
The root `Dockerfile` accepts `SANDBOX_UID` (default `1000`) and `SANDBOX_GID` (default `1000`), and `scripts/build-sandbox.sh` forwards `NANOGEM_SANDBOX_UID` / `NANOGEM_SANDBOX_GID` if you need a custom non-root ID.

> **Security Warning:** Never mount or expose the host Docker socket (`/var/run/docker.sock`) into the agent sandbox container—doing so grants root-equivalent control over the host.

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env and set GEMINI_API_KEY
```

### 3. Lint, Build, and Run
```bash
npm run lint
npm run build
npm start
```
For local development with Vite HMR:
```bash
npm run dev
```

By default, NanoGem binds only to loopback (`http://127.0.0.1:3000`).

---

## Configuration Reference

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | _(required for chat)_ | Gemini API key (kept strictly on the server) |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback binds require `NANOGEM_API_TOKEN` |
| `PORT` | `3000` | HTTP port |
| `NANOGEM_API_TOKEN` | `""` | Bearer/`X-NanoGem-Token` auth secret (min 16 chars for public bind) |
| `NANOGEM_EXECUTION_MODE` | `docker` | `"docker"` (default, fail-closed) or explicit `"host"` opt-in (local dev only) |
| `NANOGEM_SANDBOX_IMAGE` | `nanogem-sandbox:latest` | Sandbox image (`ghcr.io/jqcvsc/nanogem-sandbox:sha-<commit>` recommended; `NANOGEM_DOCKER_IMAGE` also accepted) |
| `NANOGEM_DOCKER_USER` | `1000:1000` | Non-root UID:GID for container execution (root/`0` rejected) |
| `NANOGEM_DOCKER_NETWORK` | `none` | Container network mode (`none` disables networking) |
| `NANOGEM_DOCKER_CPUS` | `1.0` | CPU quota (`--cpus`) |
| `NANOGEM_DOCKER_MEMORY` | `512m` | Memory and swap ceiling (`--memory` & `--memory-swap`) |
| `NANOGEM_DOCKER_PIDS_LIMIT` | `64` | Maximum processes/threads (`--pids-limit`) |
| `NANOGEM_DOCKER_READ_ONLY` | `true` | Mount rootfs read-only with bounded `tmpfs` |
| `NANOGEM_COMMAND_TIMEOUT_MS` | `30000` | Per-command timeout in milliseconds |
| `NANOGEM_MAX_OUTPUT_BYTES` | `1048576` | Max stdout/stderr buffer per command (1 MiB) |

---

## Authentication & Network Exposure

**Never expose NanoGem publicly without authentication.**
- By default, `HOST` is `127.0.0.1` and unauthenticated non-loopback requests are rejected.
- If you set `HOST=0.0.0.0` (or any non-loopback address), the server **refuses to start** unless `NANOGEM_API_TOKEN` is configured with at least 16 non-placeholder characters.
- Authenticate API requests using `Authorization: Bearer <NANOGEM_API_TOKEN>` or `X-NanoGem-Token: <NANOGEM_API_TOKEN>` (or enter the token in the web UI prompt).

---

## Host Execution Opt-In (Unsafe — Local Development Only)

If a container runtime (Docker/Podman) is unavailable in a **trusted local development** environment, you can explicitly opt into direct host execution:
```bash
NANOGEM_EXECUTION_MODE=host npm start
```
NanoGem fails closed when `NANOGEM_EXECUTION_MODE=docker` (the default) and never silently falls back from `docker` to `host`. Never enable `host` mode on shared, untrusted, or publicly reachable servers. See [SECURITY.md](./SECURITY.md) before enabling `host` mode.
