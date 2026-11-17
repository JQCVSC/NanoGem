# NanoGem Website & Product Copy

> **A Gemini-native coding agent for local projects, with a boundary around autonomous execution.**

---

## Hero

**Headline:**
A Gemini-native coding agent for local projects, with a boundary around autonomous execution.

**Subheadline:**
Run Google Gemini coding tasks on your own repositories from a browser workbench or an allowlisted Telegram chat—with file writes, shell commands, project memory, Git review, and optional scheduled checks isolated inside an ephemeral Docker sandbox.

**Primary Actions:**
- Get Started on GitHub (`https://github.com/JQCVSC/NanoGem`)
- Read the Security Model (`SECURITY.md`)

---

## Why NanoGem

1. **Docker Sandbox by Default (`NANOGEM_EXECUTION_MODE=docker`)**
   Every autonomous command runs inside an ephemeral Linux container (`--user 1000:1000`, `--cap-drop=ALL`, `--security-opt=no-new-privileges:true`, `--read-only`, `--network=none`, and CPU/memory/PID limits) with only the active project's workspace mounted at `/workspace`. Host execution requires an explicit `NANOGEM_EXECUTION_MODE=host` opt-in and never triggers as a silent fallback.

2. **Built Natively Around `@google/genai`**
   NanoGem connects directly to the Google Gemini API from the host server. API keys stay on the server and are never injected into the sandbox container.

3. **Persistent Projects, Instructions & Curated Memory**
   Store project sessions and structured execution events in SQLite. Customize behavior per project with `GEMINI.md` and explicitly curated `MEMORY.md` notes—protected against silent model overwrites and automatic secret-file imports.

4. **Human-in-the-Loop Git Review & Revert**
   Inspect branch status and diffs directly in the workbench, create safe branches, revert uncommitted changes with explicit confirmation, or commit locally. Remote `git push` is not enabled, and host SSH keys are never mounted into the container.

5. **Host-Side Telegram Channel & Opt-In Schedules**
   Interact with isolated per-chat project workspaces over Telegram long polling with fail-closed user/chat allowlists, or opt into recurring test, repo-status, and dependency-check schedules (`NANOGEM_SCHEDULES_ENABLED=true`).

---

## Honest Boundaries (What NanoGem Does Not Claim)

- **Not offline or zero-egress:** Command execution and artifacts remain local to your machine, while prompts, `GEMINI.md`/`MEMORY.md` context, and confirmed workflow file excerpts are sent to the Google Gemini API (processed by Google).
- **Container runtime still required:** Prebuilt GHCR images and GitHub Actions artifacts eliminate local Docker builds, not the need for Docker or Podman at runtime.
- **Gemini-only today:** An internal `AgentProvider` seam exists in code, while Google Gemini is the only enabled production provider.
- **Containers are not hardware VMs:** Keep your Docker/Podman runtime patched, never mount `/var/run/docker.sock` into the sandbox, and treat repository files as untrusted content.
