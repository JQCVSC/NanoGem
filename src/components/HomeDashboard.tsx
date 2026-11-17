import React from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Container,
  FileDiff,
  Folder,
  FolderTree,
  History,
  MessageSquareCode,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { ProjectSummary, RuntimeStatus, SessionSummary } from "../types";
import type { AppTab } from "./Header";

export interface HomeDashboardProps {
  runtimeStatus: RuntimeStatus | null;
  activeProject: ProjectSummary | undefined;
  activeProjectId: string;
  activeSession: SessionSummary | undefined;
  activeSessionId: string | null;
  messageCount: number;
  onSelectTab: (tab: AppTab) => void;
  onTryPrompt: (prompt: string) => void;
}

export const GET_STARTED_PROMPTS: Array<{
  title: string;
  prompt: string;
  category: string;
}> = [
  {
    title: "Map the workspace",
    prompt: "Inspect repository files and summarize architecture",
    category: "Explore",
  },
  {
    title: "Build a backend service",
    prompt: "Build a Node.js REST API with Express and health tests",
    category: "Backend",
  },
  {
    title: "Create & test a script",
    prompt: "Write a Python script for data processing and run tests",
    category: "Python",
  },
  {
    title: "Run a security check",
    prompt: "Audit security dependencies and check for common issues",
    category: "Security",
  },
];

function formatCompactImage(image?: string): string {
  if (!image) return "nanogem-sandbox:latest";
  const shaMatch = image.match(/(sha256:|sha-)([a-f0-9]+)/i);
  if (shaMatch) {
    const repo = image.split(":")[0];
    return `${repo}:${shaMatch[1]}${shaMatch[2].slice(0, 12)}`;
  }
  return image;
}

export const HomeDashboard: React.FC<HomeDashboardProps> = ({
  runtimeStatus,
  activeProject,
  activeProjectId,
  activeSession,
  activeSessionId,
  messageCount,
  onSelectTab,
  onTryPrompt,
}) => {
  const runtimeInfo = runtimeStatus?.containerRuntime ?? runtimeStatus?.docker ?? null;
  const isHostMode = runtimeStatus?.executionMode === "host";
  const runtimeLoaded = runtimeStatus !== null;
  const runtimeAvailable = Boolean(runtimeInfo?.available);
  const imagePresent = Boolean(runtimeInfo?.imagePresent);
  const sandboxReady = runtimeLoaded && !isHostMode && runtimeAvailable && imagePresent;
  const runtimeNotReady = runtimeLoaded && !isHostMode && (!runtimeAvailable || !imagePresent);
  const networkEnabled = Boolean(runtimeInfo?.networkEnabled);
  const selectedRuntime = runtimeInfo?.selectedRuntime;

  const projectName = activeProject?.name || activeProjectId || "default";
  const workspaceLabel = activeProject?.slug ? `/workspace/${activeProject.slug}` : "/workspace";
  const branchName =
    runtimeStatus?.projectContext?.branch ||
    (runtimeStatus?.projectContext?.isGitRepo ? "main" : null);

  const sessionName =
    activeSession?.title || (activeSessionId ? `Session ${activeSessionId}` : "New session");

  const runtimeProviderLabel = !runtimeLoaded
    ? "Checking…"
    : isHostMode
      ? "Host (Direct)"
      : selectedRuntime === "docker"
        ? `Docker${runtimeInfo?.serverVersion ? ` v${runtimeInfo.serverVersion}` : ""}`
        : selectedRuntime === "podman"
          ? `Podman${runtimeInfo?.serverVersion ? ` v${runtimeInfo.serverVersion}` : ""}`
          : "Unavailable";

  const executionBoundaryLabel = !runtimeLoaded
    ? "Checking…"
    : isHostMode
      ? "Host (Unisolated)"
      : "Containerized";

  const networkPolicyLabel = !runtimeLoaded
    ? "Checking…"
    : isHostMode
      ? "Host Network"
      : networkEnabled
        ? `Enabled (${runtimeInfo?.network || "bridge"})`
        : `Disabled (${runtimeInfo?.network || "none"})`;

  const readinessLabel = !runtimeLoaded
    ? "Checking Runtime…"
    : isHostMode
      ? "Host Mode (Unsafe)"
      : sandboxReady
        ? selectedRuntime === "docker"
          ? "Docker Ready"
          : "Podman Ready"
        : runtimeAvailable
          ? "Image Missing"
          : "Runtime Not Ready";

  const readinessBadgeClass = !runtimeLoaded
    ? "bg-slate-800/80 text-slate-300 border-slate-700"
    : isHostMode
      ? "bg-amber-950/50 text-amber-300 border-amber-500/40"
      : sandboxReady
        ? "bg-[#0b2420] text-emerald-400 border-emerald-500/40"
        : "bg-rose-950/50 text-rose-300 border-rose-500/40";

  return (
    <div className="h-full overflow-y-auto bg-[#050811] text-slate-100 px-4 md:px-6 lg:px-8 py-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Hero / Welcome Section */}
        <section className="bg-[#090d18] border border-[#162035] rounded-2xl p-6 md:p-8 shadow-2xl space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-3 max-w-2xl">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#0c1424] border border-[#1b2b48] text-[11px] font-mono text-emerald-400">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Gemini Local Coding Workspace</span>
              </div>

              <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight font-mono">
                Build with Gemini. Execute inside a boundary.
              </h1>

              <p className="text-sm text-slate-300 leading-relaxed">
                NanoGem pairs Google Gemini with an isolated project sandbox so the agent can
                inspect repositories, edit files, and run build or test commands without exposing
                host credentials or system files.
              </p>
            </div>

            <div
              data-testid="home-readiness-badge"
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono font-semibold border shrink-0 ${readinessBadgeClass}`}
            >
              {sandboxReady ? (
                <ShieldCheck className="w-4 h-4 shrink-0" />
              ) : (
                <ShieldAlert className="w-4 h-4 shrink-0" />
              )}
              <span>{readinessLabel}</span>
            </div>
          </div>

          {/* Primary & Secondary Actions */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => onSelectTab("chat")}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-sm transition-colors shadow-[0_0_20px_rgba(16,185,129,0.2)] cursor-pointer"
            >
              <MessageSquareCode className="w-4 h-4" />
              <span>Open Agent</span>
              <ArrowRight className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => onSelectTab("files")}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#0c1424] hover:bg-[#121c32] text-slate-200 border border-[#1b2b48] text-xs font-medium transition-colors cursor-pointer"
            >
              <FolderTree className="w-4 h-4 text-emerald-400" />
              <span>Browse Files</span>
            </button>

            <button
              type="button"
              onClick={() => onSelectTab("git")}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#0c1424] hover:bg-[#121c32] text-slate-200 border border-[#1b2b48] text-xs font-medium transition-colors cursor-pointer"
            >
              <FileDiff className="w-4 h-4 text-emerald-400" />
              <span>Review Changes</span>
            </button>

            <button
              type="button"
              onClick={() => onSelectTab("context")}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#0c1424] hover:bg-[#121c32] text-slate-200 border border-[#1b2b48] text-xs font-medium transition-colors cursor-pointer"
            >
              <BookOpen className="w-4 h-4 text-emerald-400" />
              <span>Instructions &amp; Memory</span>
            </button>
          </div>
        </section>

        {/* Runtime Unavailable / Host Warning Banner */}
        {runtimeNotReady && (
          <section
            role="alert"
            data-testid="home-runtime-warning"
            className="bg-rose-950/35 border border-rose-500/40 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          >
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-rose-300 font-mono text-sm font-bold">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>
                  {runtimeAvailable
                    ? "Sandbox image missing — container runtime not ready"
                    : "Container runtime unavailable (Docker / Podman required)"}
                </span>
              </div>
              <p className="text-xs text-rose-100/90 leading-relaxed">
                {runtimeInfo?.error ||
                  "Neither Docker nor Podman is currently available. NanoGem fails closed and will not execute sandbox commands on the host."}
              </p>
              {runtimeInfo?.remediation && (
                <p className="text-xs text-amber-200/95 font-mono">{runtimeInfo.remediation}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => onSelectTab("setup")}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 text-slate-950 font-semibold text-xs whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Setup &amp; Status</span>
            </button>
          </section>
        )}

        {isHostMode && (
          <section
            role="alert"
            data-testid="home-host-warning"
            className="bg-amber-950/35 border border-amber-500/40 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-amber-300 font-mono text-sm font-bold">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>Host Execution Active (Container Isolation Disabled)</span>
              </div>
              <p className="text-xs text-amber-100/90 leading-relaxed">
                <code>NANOGEM_EXECUTION_MODE=host</code> is active. Commands run directly on the
                host instead of an isolated container boundary.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onSelectTab("setup")}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Setup &amp; Status</span>
            </button>
          </section>
        )}

        {/* Context & Runtime Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Active Project & Session Card */}
          <section className="bg-[#090d18] border border-[#162035] rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-mono uppercase tracking-wider text-slate-400 font-semibold">
                Active Context
              </h2>
              <span className="text-[11px] font-mono text-slate-400">
                {messageCount > 0
                  ? `${messageCount} ${messageCount === 1 ? "message" : "messages"} in chat`
                  : "Fresh session"}
              </span>
            </div>

            <div className="space-y-3 text-xs">
              <div className="bg-[#060a13] border border-[#141e33] rounded-xl p-3.5 space-y-1">
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
                  <Folder className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Active Project</span>
                </div>
                <div
                  data-testid="home-active-project"
                  className="text-sm font-mono font-semibold text-white flex flex-wrap items-center gap-2"
                >
                  <span>{projectName}</span>
                  {branchName && (
                    <span className="text-[11px] font-normal text-slate-400">
                      · branch: <span className="text-emerald-400">{branchName}</span>
                    </span>
                  )}
                </div>
                <div className="text-[11px] font-mono text-slate-500">{workspaceLabel}</div>
              </div>

              <div className="bg-[#060a13] border border-[#141e33] rounded-xl p-3.5 space-y-1">
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
                  <History className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Active Session</span>
                </div>
                <div
                  data-testid="home-active-session"
                  className="text-sm font-mono font-semibold text-white"
                >
                  {sessionName}
                </div>
                <div className="text-[11px] text-slate-500">
                  Switch projects or sessions anytime from the top bar without losing saved history.
                </div>
              </div>
            </div>
          </section>

          {/* Runtime & Security Boundary Card */}
          <section className="bg-[#090d18] border border-[#162035] rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-mono uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-2">
                <Container className="w-3.5 h-3.5 text-emerald-400" />
                <span>Sandbox Runtime</span>
              </h2>
              <button
                type="button"
                onClick={() => onSelectTab("setup")}
                className="text-[11px] font-mono text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer"
              >
                Setup &amp; Status
              </button>
            </div>

            <div className="bg-[#060a13] border border-[#141e33] rounded-xl p-4 space-y-2.5 text-xs font-mono">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-400">Runtime:</span>
                <span
                  data-testid="home-runtime-provider"
                  className={
                    isHostMode
                      ? "text-amber-300 font-semibold"
                      : runtimeAvailable
                        ? "text-emerald-400 font-semibold"
                        : "text-rose-300 font-semibold"
                  }
                >
                  {runtimeProviderLabel}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-400">Execution:</span>
                <span className={isHostMode ? "text-amber-300" : "text-slate-200"}>
                  {executionBoundaryLabel}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-400">Network Policy:</span>
                <span
                  className={`inline-flex items-center gap-1.5 ${
                    networkEnabled || isHostMode ? "text-amber-300" : "text-emerald-400"
                  }`}
                >
                  {networkEnabled || isHostMode ? (
                    <Wifi className="w-3 h-3" />
                  ) : (
                    <WifiOff className="w-3 h-3" />
                  )}
                  <span>{networkPolicyLabel}</span>
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-400">Image / Readiness:</span>
                <span
                  className="text-slate-200 truncate max-w-[240px]"
                  title={runtimeInfo?.image || "nanogem-sandbox:latest"}
                >
                  {formatCompactImage(runtimeInfo?.image)} ({readinessLabel})
                </span>
              </div>
            </div>

            {/* Safe Execution Note */}
            <div
              data-testid="home-safe-execution-note"
              className="rounded-xl bg-[#060a13] border border-[#141e33] px-3.5 py-2.5 text-[11px] text-slate-400 leading-relaxed flex items-start gap-2"
            >
              {sandboxReady ? (
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <ShieldAlert
                  className={`w-4 h-4 shrink-0 mt-0.5 ${
                    isHostMode ? "text-amber-400" : runtimeNotReady ? "text-rose-400" : "text-slate-400"
                  }`}
                />
              )}
              <span>
                {isHostMode
                  ? "Isolation disabled: host execution mode is active. Switch back to containerized execution before running untrusted tasks."
                  : runtimeNotReady
                    ? "Safe execution (fail-closed): commands stay blocked until Docker or Podman and the configured sandbox image are ready."
                    : "Safe execution: commands run inside the isolated sandbox container with read-only rootfs, no host secrets, and workspace-only mounts."}
              </span>
            </div>
          </section>
        </div>

        {/* Get Started Example Prompts */}
        <section className="bg-[#090d18] border border-[#162035] rounded-2xl p-5 md:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-mono font-bold text-white">Get started</h2>
            </div>
            <span className="text-xs text-slate-400">
              Select a starter prompt to load it in Agent Chat
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {GET_STARTED_PROMPTS.map((item) => (
              <button
                key={item.prompt}
                type="button"
                onClick={() => onTryPrompt(item.prompt)}
                className="group bg-[#060a13] hover:bg-[#0c1424] border border-[#162035] hover:border-emerald-500/40 rounded-xl p-4 text-left transition-all flex flex-col justify-between gap-2 cursor-pointer"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono font-semibold text-emerald-400">
                    {item.category} · {item.title}
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-emerald-400 group-hover:translate-x-0.5 transition-all" />
                </div>
                <p className="text-xs font-mono text-slate-300 group-hover:text-white leading-snug">
                  &gt; {item.prompt}
                </p>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
