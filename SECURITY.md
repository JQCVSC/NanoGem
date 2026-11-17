# Security Policy & Sandbox Architecture

## Overview

NanoGem executes AI-generated and user-entered shell commands. By default (`NANOGEM_EXECUTION_MODE=docker`), all command execution is isolated inside ephemeral Docker containers with defense-in-depth restrictions.

---

## Sandbox Isolation Controls (Default `docker` Mode)

Every command executed via `POST /api/workspace/terminal` or the Gemini `execute_system_command` tool runs in a fresh ephemeral container (`docker run --rm --init`) with the following controls enforced by `src/server/sandboxRuntime.ts`:

1. **Minimal Workspace Mount Only**
   - Only `./sandbox_workspace` is bind-mounted into the container at `/workspace` (`--mount type=bind,source=<workspaceDir>,target=/workspace`).
   - Host directories such as `.env`, `~/.ssh`, `/etc`, `/var/run/docker.sock`, and the server source tree are never mounted.

2. **Non-Root Execution**
   - The root `Dockerfile` removes the default `node` account, strips setuid/setgid bits (`chmod a-s`), and runs as a dedicated non-root user `sandbox` (UID/GID `1000:1000` by default).
   - `server.ts` explicitly passes `--user <uid>:<gid>` and rejects `0`, `0:0`, or `root` at configuration load time.

3. **Dropped Capabilities & Privilege Escalation Prevention**
   - `--cap-drop=ALL` drops all Linux kernel capabilities.
   - `--security-opt=no-new-privileges:true` prevents gaining privileges via setuid binaries or file capabilities.

4. **Read-Only Root Filesystem**
   - `--read-only` mounts the container root filesystem read-only by default (`NANOGEM_DOCKER_READ_ONLY=true`).
   - Ephemeral `tmpfs` mounts are provided for `/tmp` (`noexec,nosuid,nodev,size=128m`) and `/home/sandbox` (`nosuid,nodev,size=64m`).

5. **Network Disabled by Default**
   - `--network=none` blocks all inbound and outbound container networking by default (`NANOGEM_DOCKER_NETWORK=none`).
   - Prevents data exfiltration, SSRF against local/metadata endpoints, and unintended package/C2 downloads.

6. **Resource & Timeout Limits**
   - `--cpus=1.0` (`NANOGEM_DOCKER_CPUS`)
   - `--memory=512m` and `--memory-swap=512m` (`NANOGEM_DOCKER_MEMORY`)
   - `--pids-limit=64` (`NANOGEM_DOCKER_PIDS_LIMIT`) to mitigate fork bombs
   - Per-command timeout (`NANOGEM_COMMAND_TIMEOUT_MS=30000`) terminates and removes (`docker rm -f`) the named container on expiry
   - Output buffering capped at 1 MiB (`NANOGEM_MAX_OUTPUT_BYTES`)

7. **Secret Isolation**
   - Host environment variables—including `GEMINI_API_KEY` and `NANOGEM_API_TOKEN`—are never passed into the sandbox container.

---

## Host Execution Opt-In (`NANOGEM_EXECUTION_MODE=host`)

- NanoGem **never** falls back to host execution automatically if Docker is missing or misconfigured.
- Direct host execution is available **only** when `NANOGEM_EXECUTION_MODE=host` is explicitly set.
- Even in `host` mode, host secrets such as `GEMINI_API_KEY` and `NANOGEM_API_TOKEN` are omitted from the child process environment, and `cwd` is set to `sandbox_workspace`.
- **Warning:** In `host` mode, commands run with the privileges of the Node.js server process and full host filesystem/network access. Never use `host` mode with untrusted prompts or on a shared/public server.

---

## Authentication & Public Exposure Controls

NanoGem exposes file management and command execution endpoints (`/api/workspace/*`, `/api/agent/chat`). **Do not expose NanoGem publicly without authentication.**

- **Loopback Default:** `HOST` defaults to `127.0.0.1`.
- **Fail-Closed Public Bind Guard:** Binding to any non-loopback address (such as `0.0.0.0`) is blocked at startup unless `NANOGEM_API_TOKEN` is set to a strong token (at least 16 characters, non-placeholder).
- **Constant-Time Verification:** API tokens sent via `Authorization: Bearer <token>` or `X-NanoGem-Token` are verified using SHA-256 digests and `crypto.timingSafeEqual`.
- **Loopback Enforcement:** When `NANOGEM_API_TOKEN` is unset on a loopback bind, requests from non-loopback remote addresses are rejected (`403 Forbidden`).
- **Reverse Proxies:** If placing NanoGem behind HTTPS/TLS termination (recommended for any remote access), terminate TLS at the reverse proxy, keep `NANOGEM_API_TOKEN` enabled, and do not forward untrusted unauthenticated traffic.

---

## Workspace File Access Protections

All `/api/workspace/file` reads, writes, and deletes pass through `resolveSafeWorkspacePath`, which:
- Rejects null bytes, directory traversal (`..`), and sibling-prefix bypasses (`sandbox_workspace_evil`).
- Resolves real paths (`fs.realpath` / `fs.lstat`) to block symlink escapes planted inside `/workspace` from reading or overwriting host files outside `sandbox_workspace`.

---

## Residual Risks & Operational Best Practices

- Containers share the host kernel; keep Docker Engine and the host kernel patched.
- Avoid setting `NANOGEM_DOCKER_NETWORK=bridge` unless package installation inside the container is intentionally required, and monitor resource limits for your workload.
- Treat files inside `sandbox_workspace/` as untrusted container output before executing them on the host.
- Report security issues privately to the repository maintainers rather than opening public issues with active exploit payloads.
