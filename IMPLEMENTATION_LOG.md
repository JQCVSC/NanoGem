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
