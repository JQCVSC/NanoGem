# NanoGem Implementation Log

## Stage 0 — Reproducible Docker Sandbox Distribution (`cdc7e3d`)
- Finalized root `Dockerfile` (`SANDBOX_UID`/`SANDBOX_GID` support, non-root `sandbox` user, stripped setuid/setgid bits), `.dockerignore`, and `scripts/build-sandbox.sh`.
- Added `.github/workflows/docker-sandbox.yml` (Buildx build, hardened container smoke test, `nanogem-sandbox-image` artifact upload, least-privilege GHCR publish to `ghcr.io/jqcvsc/nanogem-sandbox` with `latest` and `sha-<full-commit-sha>`).
- Added `NANOGEM_SANDBOX_IMAGE` support (retaining `NANOGEM_DOCKER_IMAGE` fallback) and updated `README.md`, `SECURITY.md`, and `.env.example`.
- Pushed `main` to `origin/main` and verified GitHub Actions run `44031242188` (`build-and-smoke-test` + `publish-ghcr` + `nanogem-sandbox-image` artifact) succeeded.
- Configured local `.env` (gitignored) with `NANOGEM_EXECUTION_MODE="docker"` and `NANOGEM_SANDBOX_IMAGE="ghcr.io/jqcvsc/nanogem-sandbox:sha-cdc7e3d62a090655a5bb990411ea19df5adaed92"`.

## Stage 1 — Repository & Security Audit
- Audited `src/server/sandboxRuntime.ts`, `src/server/auth.ts`, `server.ts`, `src/components/*`, `README.md`, and `.env.example`.
- Fixed issues found:
  1. Hardened `resolveSafeWorkspacePath` in `src/server/sandboxRuntime.ts` to walk every path segment from `workspaceReal` and reject intermediate symlinks (including dangling symlinks) escaping `sandbox_workspace`.
  2. Hardened `getWorkspaceFilesTree` in `server.ts` to skip symlinks and use `fs.lstat` so symlinks/dangling symlinks cannot leak host metadata or crash file listing.
  3. Updated `POST /api/workspace/file` to validate `content` type (`400`) and return `403` on rejected paths; updated `GET /api/workspace/file` to return `404`/`400` on missing files/directories; updated `POST /api/workspace/terminal` to reject non-string/blank commands (`400`).
  4. Updated `POST /api/agent/chat` to reject `.env.example` placeholder `GEMINI_API_KEY` values (`503`) and safely validate tool call arguments.
  5. Added JSON `404` handler for unmatched `/api/*` routes so authenticated API typos do not fall through to SPA HTML.
  6. Fixed discrepancies between `src/components/CodebaseExport.tsx`, `/api/nanogemini/source`, `.env.example`, and `README.md` (`Node.js 22`, `NANOGEM_SANDBOX_IMAGE`, `NANOGEM_MAX_OUTPUT_BYTES`).
- Added regression tests in `tests/sandbox.test.ts` and `tests/smoke.test.ts`.

## Stage 2 — Extract Reusable Gemini Agent Service
- Added `src/agent/agentService.ts` containing `@google/genai` invocation, `DEFAULT_GEMINI_MODEL`, `DEFAULT_SYSTEM_INSTRUCTION`, history conversion, tool-call loop (`execute_system_command`, `write_local_file`), maximum-turn protection (`maxTurns`), and structured lifecycle events (`assistant_text`, `tool_call_requested`, `tool_result`, `command_started`, `command_completed`, `command_failed`, `final_response`, `execution_error`).
- Added `executeSandboxCommandDetailed` in `src/server/sandboxRuntime.ts` so `agentService.ts` gets deterministic command exit/failure status without changing `executeSandboxCommand`.
- Refactored `server.ts` `/api/agent/chat` to call `runGeminiAgent` rather than duplicating the Gemini loop, preserving browser API compatibility.
- Added unit tests in `tests/agentService.test.ts` covering direct response, sandboxed tool calls, tool/API failures, and maximum-turn termination.

## Stage 3 — Persistent Project & Session Storage
- Added `src/storage/database.ts` using Node's built-in `node:sqlite` (`DatabaseSync`) with migration tracking (`schema_migrations`), WAL mode, and foreign keys (`projects`, `sessions`, `messages`, `execution_events`). No API keys or tokens are stored in SQLite.
- Added `src/storage/projectStore.ts` validating project workspace paths against an approved root (`NANOGEM_PROJECTS_ROOT`), preventing overlapping/escaping project directories, migrating `./sandbox_workspace` as `"default"`, and scoping workspace file/sandbox access per project.
- Added `src/storage/sessionStore.ts` enforcing single-project ownership on every session, message, and execution event, and supporting session creation, listing, resumption, and history retrieval.
- Added project/session REST endpoints (`/api/projects`, `/api/projects/:id/select`, `/api/sessions`, `/api/sessions/:id`) and scoped `/api/workspace/*` and `/api/agent/chat` to the active project & session in `server.ts`.
- Added project/session selector and creation UI in `src/App.tsx`, `src/components/FileWorkspace.tsx`, `src/components/InteractiveTerminal.tsx`, and `src/types.ts`.
- Added `.nanogem/` and `nanogem_workspaces/` to `.gitignore` and `.dockerignore`.
- Added persistence-across-restart and cross-project isolation tests in `tests/storage.test.ts` and `tests/smoke.test.ts`.

## Stage 4 — Per-Project Instructions (`GEMINI.md`) and Memory (`MEMORY.md`)
- Added `src/agent/projectContext.ts` supporting per-project `GEMINI.md` and `MEMORY.md` with 16 KiB size limits, symlink-safe loading/saving, secret-file import rejection (`.env`, `.pem`, `.key`, `id_rsa`, etc.), secret pattern redaction, and `buildProjectSystemInstruction` with untrusted-content & Gemini API data-handling boundaries.
- Protected `GEMINI.md` and `MEMORY.md` from silent model overwrites in `src/agent/agentService.ts` (`protectContextFiles`).
- Added `/api/projects/:projectId/context` (`GET`/`PUT`) and `/api/projects/:projectId/memory/append` (`POST`) in `server.ts`, and wired `GEMINI.md` + `MEMORY.md` loading into `POST /api/agent/chat`.
- Added `src/components/ProjectContextPanel.tsx` (view/edit workflow + prompt-injection & data-handling warning) and explicit `"Save to Project Memory"` action in `src/components/AgentChat.tsx`.
- Added unit tests in `tests/projectContext.test.ts`.

## Stage 5 — Shared Agent Progress Event Stream (SSE)
- Added channel-agnostic `src/agent/progressStream.ts` (`AgentProgressStream`, `ProgressEvent`, `sanitizeCommandSummary`) emitting concise stages (`analyzing_request`, `calling_gemini`, `running_command`, `command_completed`, `command_failed`, `reviewing_changes`, `finished`, `error`) with secret/argument redaction and zero Telegram/Express coupling.
- Added `onPhase` hook in `src/agent/agentService.ts`.
- Added `POST /api/agent/chat/stream` SSE endpoint in `server.ts` sharing `executeProjectChatTurn` with `POST /api/agent/chat` (non-streaming clients remain compatible), keeping final assistant response separate from `progress` events and persisting results even if the client disconnects mid-stream.
- Updated `src/App.tsx`, `src/components/AgentChat.tsx`, and `src/types.ts` to stream and render live progress stages.
- Added unit tests in `tests/progressStream.test.ts` covering event ordering, secret redaction, and failed commands.
