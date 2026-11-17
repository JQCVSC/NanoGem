import React from "react";
import {
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  Container,
  Bot,
  FolderPlus,
  BookOpen,
  FileDiff,
  RefreshCw,
  ExternalLink,
  Wifi,
} from "lucide-react";
import { RuntimeStatus } from "../types";
import type { AppTab } from "./Header";

interface SetupStatusPanelProps {
  runtimeStatus: RuntimeStatus | null;
  projectName: string;
  onRefreshStatus: () => void;
  onOpenNewProject: () => void;
  onSelectTab: (tab: AppTab) => void;
}

export const SetupStatusPanel: React.FC<SetupStatusPanelProps> = ({
  runtimeStatus,
  projectName,
  onRefreshStatus,
  onOpenNewProject,
  onSelectTab,
}) => {
  const runtimeInfo = runtimeStatus?.containerRuntime ?? runtimeStatus?.docker;
  const isHostMode = runtimeStatus?.executionMode === "host";
  const runtimeAvailable = Boolean(runtimeInfo?.available);
  const imagePresent = Boolean(runtimeInfo?.imagePresent);
  const sandboxReady = runtimeAvailable && imagePresent;
  const networkEnabled = Boolean(runtimeInfo?.networkEnabled);
  const apiKeyConfigured = Boolean(runtimeStatus?.provider?.apiKeyConfigured);
  const projCtx = runtimeStatus?.projectContext;
  const configuredImage =
    runtimeInfo?.image ||
    "ghcr.io/jqcvsc/nanogem-sandbox:sha-f8526c76498203b867960cd8bf244c04355f21a1";
  const selectedRuntimeLabel = runtimeInfo?.selectedRuntime
    ? runtimeInfo.selectedRuntime
    : "none";

  return (
    <div className="h-[calc(100vh-110px)] overflow-y-auto bg-slate-950 text-slate-100 font-mono p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Top Banner */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-bold text-slate-100">
              NanoGem Readiness &amp; Security Posture
            </h2>
            <p className="text-xs text-slate-400">
              Review container runtime availability (Docker or Podman), Gemini API key status, project instructions, and Telegram setup before running tasks.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenNewProject}
              className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>Create / Import Project</span>
            </button>
            <button
              type="button"
              onClick={onRefreshStatus}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Re-check</span>
            </button>
          </div>
        </div>

        {/* Status Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {/* Container Runtime & Sandbox Readiness */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-slate-100">
                <Container className="w-4 h-4 text-emerald-400" />
                <span>Container Sandbox Runtime</span>
              </div>
              {isHostMode ? (
                <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/40 font-bold">
                  Host Mode (Unsafe Opt-In)
                </span>
              ) : sandboxReady ? (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 font-bold">
                  {selectedRuntimeLabel === "podman" ? "Podman Ready" : "Docker Ready"}
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/40 font-bold">
                  {runtimeAvailable ? "Sandbox Image Missing" : "Runtime Unavailable"}
                </span>
              )}
            </div>

            {isHostMode ? (
              <div className="bg-amber-950/30 border border-amber-500/40 rounded-lg p-3 text-amber-200 space-y-1">
                <p className="font-bold flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4" /> Direct Host Execution Active
                </p>
                <p className="text-[11px]">
                  <code>NANOGEM_EXECUTION_MODE=host</code> was explicitly set. Commands run directly on your host without container isolation. Use only in trusted local development.
                </p>
              </div>
            ) : (
              <div className="space-y-2 text-slate-300 text-[11px]">
                <p>
                  Execution Mode: <code className="text-emerald-300">{runtimeStatus?.executionMode || "docker"}</code> | Configured Runtime:{" "}
                  <code>{runtimeInfo?.configuredRuntime || "auto"}</code>
                </p>
                <p>
                  Selected Runtime:{" "}
                  <code className={runtimeAvailable ? "text-emerald-300" : "text-rose-300"}>
                    {selectedRuntimeLabel}
                  </code>{" "}
                  ({runtimeAvailable ? `Available${runtimeInfo?.serverVersion ? ` v${runtimeInfo.serverVersion}` : ""}` : "Unavailable"})
                </p>
                <p>
                  Configured Image: <code className="text-emerald-300 break-all">{configuredImage}</code>
                </p>
                <p>
                  User: <code>{runtimeInfo?.user || "1000:1000"}</code> | Read-only rootfs:{" "}
                  <code>{String(runtimeInfo?.readOnly ?? true)}</code>
                </p>
                {networkEnabled ? (
                  <p className="text-amber-300 flex items-center gap-1.5">
                    <Wifi className="w-3.5 h-3.5" />
                    <span>
                      Network Policy: <code>{runtimeInfo?.network}</code> (Enabled — default is <code>none</code>)
                    </span>
                  </p>
                ) : (
                  <p className="text-emerald-300 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Network Policy: <code>{runtimeInfo?.network || "none"}</code> (Disabled)</span>
                  </p>
                )}

                {!sandboxReady && (
                  <div className="bg-rose-950/30 border border-rose-500/40 rounded-lg p-3 text-rose-200 space-y-2">
                    <p className="font-bold">Remediation Required (Fail-Closed — No Host Fallback):</p>
                    <p>{runtimeInfo?.error || "Neither Docker nor Podman is available."}</p>
                    {runtimeInfo?.remediation && <p className="text-amber-200">{runtimeInfo.remediation}</p>}
                    <pre className="bg-slate-950 p-2 rounded text-[11px] overflow-x-auto text-emerald-300">
{`# Option A (Docker Desktop on Windows):
winget install -e --id Docker.DockerDesktop
docker pull ${configuredImage}

# Option B (Podman on Windows):
winget install -e --id RedHat.Podman
podman machine init && podman machine start
podman pull ${configuredImage}`}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Gemini Key Guidance (never displays secret value) */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-slate-100">
                <KeyRound className="w-4 h-4 text-emerald-400" />
                <span>Gemini API Configuration</span>
              </div>
              {apiKeyConfigured ? (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 font-bold">
                  Configured (Hidden)
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/40 font-bold">
                  Missing Key
                </span>
              )}
            </div>
            <p className="text-slate-300 text-[11px] leading-relaxed">
              <code>GEMINI_API_KEY</code> is kept strictly on the host server and is never displayed in the UI or passed into the sandbox container. Prompts and loaded context are sent to the Google Gemini API.
            </p>
            {!apiKeyConfigured && (
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-1 text-[11px]">
                <p className="text-amber-300 font-bold">Configure in .env and restart NanoGem:</p>
                <pre className="text-emerald-300 overflow-x-auto">
{`cp .env.example .env
# Set GEMINI_API_KEY="your-real-key" in .env
npm run build && npm start`}
                </pre>
              </div>
            )}
          </div>

          {/* Active Project Context & Git State */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 font-bold text-slate-100">
              <BookOpen className="w-4 h-4 text-emerald-400" />
              <span>Active Project: {projectName}</span>
            </div>
            <div className="space-y-1.5 text-[11px]">
              <p>
                <code>GEMINI.md</code>:{" "}
                {projCtx?.hasGeminiMd ? (
                  <span className="text-emerald-400">Loaded</span>
                ) : (
                  <span className="text-amber-300">Not created yet (optional project rules)</span>
                )}
              </p>
              <p>
                <code>MEMORY.md</code>:{" "}
                {projCtx?.hasMemoryMd ? (
                  <span className="text-emerald-400">Loaded</span>
                ) : (
                  <span className="text-amber-300">Empty (explicit user-saved notes only)</span>
                )}
              </p>
              <p>
                Git Workspace:{" "}
                {!projCtx?.isGitRepo ? (
                  <span className="text-slate-400">Non-Git folder</span>
                ) : projCtx.hasUncommittedChanges ? (
                  <span className="text-amber-300 font-bold">
                    Uncommitted changes on branch {projCtx.branch}
                  </span>
                ) : (
                  <span className="text-emerald-400">Clean on branch {projCtx.branch}</span>
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => onSelectTab("context")}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 flex items-center gap-1"
              >
                <BookOpen className="w-3 h-3 text-emerald-400" />
                <span>Edit Instructions &amp; Memory</span>
              </button>
              <button
                type="button"
                onClick={() => onSelectTab("git")}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 flex items-center gap-1"
              >
                <FileDiff className="w-3 h-3 text-emerald-400" />
                <span>Review Git Changes</span>
              </button>
            </div>
          </div>

          {/* Telegram Setup Guide */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-slate-100">
                <Bot className="w-4 h-4 text-emerald-400" />
                <span>Telegram Channel Adapter</span>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  runtimeStatus?.telegram?.configured
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"
                    : "bg-slate-800 text-slate-400"
                }`}
              >
                {runtimeStatus?.telegram?.configured ? "Polling Enabled" : "Not Configured"}
              </span>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              Telegram runs host-side via long polling and maps each chat to its own isolated project/session (separate from the browser workspace). Set these in <code>.env</code>:
            </p>
            <pre className="bg-slate-950 border border-slate-800 rounded p-2.5 text-[11px] text-emerald-300 overflow-x-auto">
{`TELEGRAM_BOT_TOKEN="123456:..."
TELEGRAM_ALLOWED_USER_IDS="your_numeric_telegram_user_id"
TELEGRAM_REQUIRE_MENTION="true"
TELEGRAM_POLLING="true"`}
            </pre>
          </div>
        </div>

        {/* Security Documentation Links */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="text-slate-300">
            Review the threat model, container isolation controls, and deployment checklist before exposing NanoGem beyond <code>127.0.0.1</code>.
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/JQCVSC/NanoGem/blob/main/SECURITY.md"
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 hover:underline flex items-center gap-1"
            >
              <span>SECURITY.md</span>
              <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href="https://github.com/JQCVSC/NanoGem/blob/main/README.md"
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 hover:underline flex items-center gap-1"
            >
              <span>README.md</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
