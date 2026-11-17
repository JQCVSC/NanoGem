# NanoGem Release Candidate Checklist

## Passed Checks

- **`npm ci`**: Passed (`223` packages audited, `0` vulnerabilities).
- **`npm run lint` (`tsc --noEmit`)**: Passed with 0 TypeScript errors.
- **`npm run build` (`vite build` + `esbuild server.ts`)**: Passed (`dist/index.html`, `dist/assets/*`, `dist/server.cjs`).
- **`bash -n scripts/build-sandbox.sh`**: Passed via Git Bash (`exit 0`).
- **All unit, integration, and built-server smoke tests (`node --test tests/*.test.ts`)**: Passed **35 / 35** tests (`0` failures, `0` skipped), covering:
  - Docker sandbox defaults, `NANOGEM_SANDBOX_IMAGE` / `NANOGEM_DOCKER_IMAGE`, fail-closed execution, host secret stripping, and path/symlink/dangling-symlink traversal protection (`tests/sandbox.test.ts`).
  - Browser REST/SSE API smoke checks on built `dist/server.cjs`: non-loopback unauthenticated bind refusal, `401` auth enforcement on `/api/*` (including `/api/projects/:id/context`, `/api/schedules`, `/api/agent/chat/stream`), `403` cross-project session access, `400` unconfirmed Git revert, `503` placeholder `GEMINI_API_KEY`, JSON `404` for unknown `/api/*` routes, and SQLite persistence across server restart (`tests/smoke.test.ts`).
  - Reusable Gemini agent service: direct response, tool execution, tool/API failure events, and `maxTurns` termination (`tests/agentService.test.ts`).
  - Persistent SQLite projects/sessions and cross-project isolation (`tests/storage.test.ts`).
  - Per-project `GEMINI.md` and `MEMORY.md` isolation, secret-file blocking/redaction, size limits, and protection against silent model overwrites (`tests/projectContext.test.ts`).
  - Shared progress event ordering, secret redaction, and failed command reporting (`tests/progressStream.test.ts`).
  - Safe Git review/diff/branch/revert/commit and non-Git workspace isolation (`tests/gitReview.test.ts`).
  - Offline Telegram channel adapter (without live bot token): fail-closed allowlists, isolated per-chat project mapping, group `@mention` gating, `/start`, `/help`, `/new`, `/reset`, `/status`, response splitting, HTML escaping, token redaction, and sandbox token stripping (`tests/telegram.test.ts`).
  - Opt-in scheduled project tasks: interval/cron validation, pause/resume/delete, concurrency locks, failure persistence, Telegram notification authorization, and restart recovery (`tests/scheduler.test.ts`).
  - Internal `AgentProvider` seam and unsupported provider rejection (`tests/provider.test.ts`).
  - Optional project workflow templates: confirmation gate, allowed/rejected extensions, sensitive-file rejection, and file/total size limits (`tests/workflows.test.ts`).
- **Remote Docker CI build & GHCR publish (commit `cdc7e3d`)**: GitHub Actions workflow **Build Sandbox Docker Image** (run `44031242188`) passed `build-and-smoke-test` (Buildx build, hardened container smoke test, `nanogem-sandbox-image` artifact) and `publish-ghcr` (`ghcr.io/jqcvsc/nanogem-sandbox:latest` and `ghcr.io/jqcvsc/nanogem-sandbox:sha-cdc7e3d62a090655a5bb990411ea19df5adaed92`).

## Blocked / Deferred Checks

- **Local `docker build` / `docker run` container smoke test**: Blocked locally because the `docker` CLI/daemon is not installed on this Windows host. Live container execution on `ubuntu-latest` is verified via `.github/workflows/docker-sandbox.yml`.
- **Live Gemini API & live Telegram Bot API network calls**: Tested offline with deterministic mocks/doubles; live end-to-end inference and Telegram polling require valid user-supplied `GEMINI_API_KEY` and `TELEGRAM_BOT_TOKEN` credentials.

## Security & Architecture Review Summary

- **Secrets in logs or containers**: Verified `GEMINI_API_KEY`, `NANOGEM_API_TOKEN`, and `TELEGRAM_BOT_TOKEN` are never passed into Docker containers, never stored in SQLite, never returned by `/api/runtime/status`, and redacted in Telegram errors and progress summaries.
- **Accidental host fallback**: Verified `NANOGEM_EXECUTION_MODE=docker` fails closed when Docker or the sandbox image is unavailable; host execution occurs only when `NANOGEM_EXECUTION_MODE=host` is explicitly set.
- **Unauthenticated destructive routes**: Verified all `/api/*` routes (except minimal `GET /api/health`) require `createApiAuthMiddleware` (token auth when configured, or strict loopback-only when `HOST` is loopback and no token is set).
- **Cross-project workspace access**: Verified `ProjectStore` validates workspaces against `NANOGEM_PROJECTS_ROOT`, `SessionStore` rejects cross-project session access, and Telegram chats map to dedicated per-chat projects separate from the browser's `default` workspace.
- **Unbounded execution**: Verified `NANOGEM_COMMAND_TIMEOUT_MS`, `NANOGEM_MAX_OUTPUT_BYTES`, `maxTurns`, 16 KiB `GEMINI.md`/`MEMORY.md` caps, and 64 KiB/128 KiB workflow upload limits.
- **Migrations & tracked files**: Verified SQLite migrations `1`–`3` apply transactionally on startup; verified `git ls-files` tracks no `.env`, SQLite `.db` files, `node_modules`, or `dist` artifacts.

## Known Limitations

- Google Gemini (`"gemini"`) is the only enabled agent provider.
- NanoGem is **not** offline or zero-egress: prompts, conversation history, loaded project context, and confirmed workflow file selections are sent to the Google Gemini API.
- Docker or Podman is required at runtime on the host for default `docker` sandbox mode, even when pulling a prebuilt GHCR image.
- Remote `git push` is intentionally not implemented.

## Exact Manual Setup Steps

1. Install Node.js 20+ and Docker (or Podman).
2. Pull the immutable GHCR sandbox image (or build locally with `./scripts/build-sandbox.sh`):
   ```bash
   docker pull ghcr.io/jqcvsc/nanogem-sandbox:sha-cdc7e3d62a090655a5bb990411ea19df5adaed92
   ```
3. Copy `.env.example` to `.env` and configure:
   - `GEMINI_API_KEY` (required for agent chat)
   - `NANOGEM_EXECUTION_MODE="docker"`
   - `NANOGEM_SANDBOX_IMAGE="ghcr.io/jqcvsc/nanogem-sandbox:sha-cdc7e3d62a090655a5bb990411ea19df5adaed92"`
   - `NANOGEM_API_TOKEN` (required `>= 16` chars if changing `HOST` from `127.0.0.1`)
   - Optional Telegram settings: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_REQUIRE_MENTION="true"`, `TELEGRAM_POLLING="true"`
   - Optional scheduler opt-in: `NANOGEM_SCHEDULES_ENABLED="true"` (defaults to `"false"`)
4. Install, verify, build, and start:
   ```bash
   npm ci
   npm run lint
   npm run build
   node --test tests/*.test.ts
   npm start
   ```
5. Open `http://127.0.0.1:3000` and review the **Setup & Status** tab before running your first task.
