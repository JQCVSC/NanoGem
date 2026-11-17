# Security Policy & Sandbox Architecture

## Overview

NanoGem is a Gemini-native local coding agent that executes AI-generated and user-entered shell commands. By default (`NANOGEM_EXECUTION_MODE=docker`), all command execution is isolated inside ephemeral Docker containers with defense-in-depth restrictions.

---

## Sandbox Isolation Controls (Default `docker` Mode)

Every command executed via `/api/workspace/terminal`, the browser agent chat, Telegram, or scheduled tasks runs inside an ephemeral container (`<docker|podman> run --rm --init`) enforced by `src/server/sandboxRuntime.ts`. `NANOGEM_EXECUTION_MODE=docker` always requires a container runtime (`NANOGEM_CONTAINER_RUNTIME=auto|docker|podman`) and **never** falls back to host execution:

1. **Minimal Workspace Mount Only**
   - Only the active project's workspace directory is bind-mounted at `/workspace`.
   - Host directories such as `.env`, `~/.ssh`, `/etc`, `/var/run/docker.sock`, and the server source tree are never mounted.

2. **Non-Root Execution**
   - The root `Dockerfile` validates positive non-zero `SANDBOX_UID`/`SANDBOX_GID` (default `1000:1000`), removes the base `node` account, strips setuid/setgid bits (`chmod a-s`), and runs as `sandbox`.
   - `sandboxRuntime.ts` passes `--user <uid>:<gid>` and rejects `0`, `0:0`, or `root` at startup.

3. **Dropped Capabilities & Privilege Escalation Prevention**
   - `--cap-drop=ALL` drops all Linux kernel capabilities.
   - `--security-opt=no-new-privileges:true` blocks privilege escalation via setuid binaries or file capabilities.

4. **Read-Only Root Filesystem**
   - `--read-only` mounts the container rootfs read-only by default (`NANOGEM_DOCKER_READ_ONLY=true`) with bounded `tmpfs` mounts for `/tmp` (`noexec,nosuid,nodev,size=128m`) and `/home/sandbox` (`nosuid,nodev,size=64m`).

5. **Network Disabled by Default**
   - `--network=none` blocks inbound and outbound container networking by default (`NANOGEM_DOCKER_NETWORK=none`).

6. **Resource & Timeout Limits**
   - `--cpus=1.0`, `--memory=512m`, `--memory-swap=512m`, `--pids-limit=64`.
   - Per-command timeout (`NANOGEM_COMMAND_TIMEOUT_MS=30000`) terminates and deletes (`docker rm -f`) the named container on expiry.
   - Output buffering is capped at `NANOGEM_MAX_OUTPUT_BYTES` (1 MiB).

7. **Secret Isolation**
   - `GEMINI_API_KEY`, `NANOGEM_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, and other host environment secrets are never passed into containers or stored in SQLite.
   - `Dockerfile` contains no host secrets and `.dockerignore` excludes `.env*`, `.nanogem/`, and workspaces.

---

## Prebuilt Sandbox Image Distribution (CI & GHCR)

- `.github/workflows/docker-sandbox.yml` builds the canonical root `Dockerfile`, runs a hardened container smoke test, uploads `nanogem-sandbox-latest.tar.gz` as an artifact, and publishes `ghcr.io/jqcvsc/nanogem-sandbox` on pushes to `main` (never on pull requests).
- **Prefer immutable tags (`sha-<full-commit-sha>`)** over `latest` in `NANOGEM_SANDBOX_IMAGE` for repeatable or production setups.
- **Runtime requirement:** Using a CI-built image removes local build overhead, but **Docker or Podman is still required at runtime**. NanoGem fails closed if Docker or the configured image is unavailable.
- **Never expose the Docker socket:** Never mount `/var/run/docker.sock` (or Podman socket) into the sandbox container.

---

## Project, Memory, Git, Telegram & Scheduler Boundaries

- **Project & Session Isolation:** Project workspace paths are validated against `NANOGEM_PROJECTS_ROOT` (blocking traversal, overlapping workspaces, and symlink escapes). Every SQLite session belongs to one project; cross-project session access returns `403`.
- **Untrusted Context & Memory Guard:** `GEMINI.md` and `MEMORY.md` are capped at 16 KiB each, protected against silent `write_local_file` overwrites by the model, and block automatic import of secret-like files (`.env`, `*.pem`, `*.key`, `id_rsa`, etc.) while redacting common secret patterns. Repository files are treated as untrusted content in prompts and UI warnings.
- **Git Review Boundary:** Git status/diff/branch/revert/commit checks `--show-toplevel` against the project workspace itself (never walking up into a parent repository), strips SSH/credential env vars, requires explicit confirmation (`confirm=true`) for revert and commit, and does not implement remote `git push`.
- **Telegram Channel Boundary:** Runs host-side only, fails closed when `TELEGRAM_ALLOWED_USER_IDS` is empty, enforces group `@mention` by default, isolates each Telegram chat into its own project workspace (separate from the browser's `default` workspace), and redacts bot tokens from errors and logs.
- **Scheduled Tasks Boundary:** Disabled by default (`NANOGEM_SCHEDULES_ENABLED=false`), bound to approved projects, guarded against concurrent execution on the same project workspace, and restricted to authorized Telegram notification targets.
- **Gemini API Data-Handling Limitation:** NanoGem is not offline; prompts, conversation history, loaded `GEMINI.md`/`MEMORY.md`, and confirmed workflow file selections are processed by Google's Gemini API.

---

## Authentication & Network Exposure

- `HOST` defaults to `127.0.0.1`; non-loopback binds refuse to start unless `NANOGEM_API_TOKEN` has at least 16 non-placeholder characters.
- API tokens are verified in constant time via SHA-256 + `crypto.timingSafeEqual`.
- Unauthenticated non-loopback requests on loopback binds are rejected (`403 Forbidden`).

---

## Host Execution Opt-In (`NANOGEM_EXECUTION_MODE=host`, Local Dev Only)

- NanoGem **never** falls back to host execution automatically.
- `host` mode runs only when `NANOGEM_EXECUTION_MODE=host` is explicitly configured and should never be used with untrusted repositories or public bindings.

---

## Security Disclosure Process

If you discover a security vulnerability in NanoGem:

1. **Do not** open a public GitHub issue containing exploit payloads, credentials, or reproduction steps against live systems.
2. Report the issue privately to the repository maintainers via GitHub Security Advisories (`https://github.com/JQCVSC/NanoGem/security/advisories/new`) or private maintainer contact listed in repository metadata.
3. Include affected files/endpoints, reproduction steps, impact assessment, and any suggested remediation.
4. Maintainers will acknowledge receipt, investigate, prepare a patch with regression tests, and coordinate disclosure once a fix is available.
