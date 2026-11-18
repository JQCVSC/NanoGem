import React, { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Container,
  FileDiff,
  FolderTree,
  GitBranch,
  KeyRound,
  MessageSquareCode,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Activity,
  FileSpreadsheet,
  Clock,
} from "lucide-react";
import type { ProjectSummary, RuntimeStatus, SessionSummary } from "../types";
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

const STARTER_PROMPTS = [
  {
    title: "Inspect Project Architecture",
    category: "Analysis",
    detail: "Map entry points, dependencies, and runtime config",
    prompt: "Inspect repository files in /workspace and summarize the architecture and entry points.",
  },
  {
    title: "Run & Verify Test Suite",
    category: "Verification",
    detail: "Execute existing tests inside the isolated sandbox",
    prompt: "Run the project test suite inside /workspace and report any failures or warnings.",
  },
  {
    title: "Build a Node.js API Endpoint",
    category: "Backend",
    detail: "Scaffold an Express route with health check tests",
    prompt: "Build a Node.js REST API with Express and health tests inside /workspace.",
  },
  {
    title: "Audit Dependencies & Security",
    category: "Security",
    detail: "Check packages and configuration for common risks",
    prompt: "Audit dependencies and configuration in /workspace for vulnerabilities or misconfigurations.",
  },
];

const WORKBENCH_MODULES: Array<{
  tab: AppTab;
  title: string;
  description: string;
  icon: React.FC<{ className?: string }>;
}> = [
  {
    tab: "chat",
    title: "Agent Chat",
    description: "Run Gemini tasks with live streaming progress, command logs, and memory saving.",
    icon: MessageSquareCode,
  },
  {
    tab: "files",
    title: "Workspace Files",
    description: "Browse, edit, and create files scoped strictly inside the active project workspace.",
    icon: FolderTree,
  },
  {
    tab: "context",
    title: "Instructions & Memory",
    description: "Manage GEMINI.md project rules and explicitly curated MEMORY.md notes.",
    icon: BookOpen,
  },
  {
    tab: "git",
    title: "Git Review",
    description: "Inspect diffs, branch state, and commit or revert changes with confirmation.",
    icon: FileDiff,
  },
  {
    tab: "terminal",
    title: "Terminal Console",
    description: "Execute single-shot sandbox shell commands directly against /workspace.",
    icon: Terminal,
  },
  {
    tab: "workflows",
    title: "Structured Workflows",
    description: "Run technical research, documentation, and Python report templates on project files.",
    icon: FileSpreadsheet,
  },
  {
    tab: "schedules",
    title: "Schedules & Jobs",
    description: "Review and trigger recurring test, repo-status, and dependency check jobs.",
    icon: Clock,
  },
  {
    tab: "setup",
    title: "Setup & Status",
    description: "Verify Docker/Podman isolation, Gemini API key readiness, and Telegram polling.",
    icon: Activity,
  },
];

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
  const [logoFailed, setLogoFailed] = useState(false);

  const runtimeInfo = runtimeStatus?.containerRuntime ?? runtimeStatus?.docker;
  const isHostMode = runtimeStatus?.executionMode === "host";
  const runtimeAvailable = Boolean(runtimeInfo?.available);
  const imagePresent = Boolean(runtimeInfo?.imagePresent);
  const sandboxReady = runtimeAvailable && imagePresent;
  const selectedRuntime = runtimeInfo?.selectedRuntime;
  const networkEnabled = Boolean(runtimeInfo?.networkEnabled);
  const apiKeyConfigured = Boolean(runtimeStatus?.provider?.apiKeyConfigured);
  const projCtx = runtimeStatus?.projectContext;

  const projectName = activeProject?.name || activeProjectId || "default";
  const workspacePathLabel = activeProject?.slug ? `/workspace/${activeProject.slug}` : "/workspace";
  const sessionLabel = activeSession?.title || (activeSessionId ? "Active Session" : "New Session");
  const modelLabel = activeSession?.model || "gemini-3.6-flash";

  const executionLabel = isHostMode
    ? "Host Mode (Direct)"
    : selectedRuntime === "docker"
      ? "Docker Sandbox"
      : selectedRuntime === "podman"
        ? "Podman Sandbox"
        : "Container Sandbox";

  const executionStateText = isHostMode
    ? "Isolation Disabled"
    : !runtimeStatus
      ? "Checking Runtime"
      : sandboxReady
        ? "Isolation Enforced"
        : runtimeAvailable
          ? "Image Missing"
          : "Runtime Unavailable";

  return (
    <div className="h-full overflow-y-auto bg-[#060914] text-slate-200 px-4 sm:px-6 py-6 md:py-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Hero Overview */}
        <section className="relative overflow-hidden bg-[#0b1022] border border-[#1b2544] rounded-xl p-6 md:p-8">
          <div
            className="nanogem-prism-line h-[2px] w-full absolute top-0 left-0 opacity-85"
            aria-hidden="true"
          />

          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="space-y-4 max-w-3xl">
              <div className="flex items-center gap-3">
                {!logoFailed ? (
                  <img
                    src="https://i.imgur.com/GEboDT3.png"
                    alt="NanoGem Logo"
                    referrerPolicy="no-referrer"
                    onError={() => setLogoFailed(true)}
                    className="h-11 w-auto max-w-[48px] object-contain nanogem-logo-glow shrink-0"
                  />
                ) : (
                  <span className="w-10 h-10 rounded-lg bg-[#111936] border border-sky-400/40 flex items-center justify-center text-sky-300 font-mono text-xs font-bold shrink-0">
                    NG
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-400">
                  <span className="text-slate-100 font-semibold">NanoGem Workbench</span>
                  <span aria-hidden="true">·</span>
                  <span>{executionLabel}</span>
                  <span aria-hidden="true">·</span>
                  <span className="text-sky-400">{workspacePathLabel}</span>
                </div>
              </div>

              <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight text-balance leading-snug">
                A Gemini-native coding agent for local projects, with a boundary around autonomous execution.
              </h1>

              <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
                Run coding tasks on your repositories with file edits, shell commands, project memory, and Git diff review isolated inside an ephemeral container sandbox.
              </p>
            </div>

            <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 shrink-0">
              <button
                type="button"
                data-testid="home-open-agent"
                onClick={() => onSelectTab("chat")}
                className="px-4 py-2.5 bg-sky-400 hover:bg-sky-300 text-[#060914] font-semibold rounded-lg text-xs sm:text-sm flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                <MessageSquareCode className="w-4 h-4 shrink-0" />
                <span>Open Agent Chat</span>
                <ArrowRight className="w-4 h-4 shrink-0" />
              </button>
              <button
                type="button"
                onClick={() => onSelectTab("files")}
                className="px-4 py-2.5 bg-[#111936] hover:bg-[#17234a] text-slate-200 border border-[#24325c] font-medium rounded-lg text-xs sm:text-sm flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                <FolderTree className="w-4 h-4 text-sky-400 shrink-0" />
                <span>Browse Files</span>
              </button>
            </div>
          </div>
        </section>

        {/* Runtime & Workspace Posture Strip */}
        <section aria-label="Workspace runtime summary" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <button
            type="button"
            data-testid="home-execution-boundary"
            onClick={() => onSelectTab("setup")}
            className="text-left bg-[#0b1022] hover:bg-[#0e152e] border border-[#1b2544] hover:border-sky-400/40 rounded-xl p-4 transition-colors space-y-2"
          >
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-medium">Execution Boundary</span>
              {isHostMode || (runtimeStatus && !sandboxReady) ? (
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
              ) : (
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              )}
            </div>
            <div data-testid="home-runtime-provider" className="text-sm font-semibold text-white font-mono truncate">
              {executionLabel}
            </div>
            <div className="text-xs font-mono text-slate-400 flex items-center gap-1.5 truncate">
              <span
                data-testid="home-readiness-badge"
                className={
                  isHostMode
                    ? "text-amber-300"
                    : sandboxReady
                      ? "text-emerald-400"
                      : "text-rose-300"
                }
              >
                {executionStateText}
              </span>
              <span aria-hidden="true">·</span>
              <span>{isHostMode ? "host net" : networkEnabled ? "net enabled" : "net: none"}</span>
            </div>
          </button>

          <button
            type="button"
            data-testid="home-active-project"
            onClick={() => onSelectTab("files")}
            className="text-left bg-[#0b1022] hover:bg-[#0e152e] border border-[#1b2544] hover:border-sky-400/40 rounded-xl p-4 transition-colors space-y-2"
          >
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-medium">Active Project</span>
              <GitBranch className="w-4 h-4 text-sky-400 shrink-0" />
            </div>
            <div className="text-sm font-semibold text-white font-mono truncate">
              {projectName}
            </div>
            <div className="text-xs font-mono text-slate-400 flex items-center gap-1.5 truncate">
              <span className="truncate">{workspacePathLabel}</span>
              {projCtx?.isGitRepo && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={projCtx.hasUncommittedChanges ? "text-amber-300" : "text-slate-300"}>
                    {projCtx.branch || "main"}
                  </span>
                </>
              )}
            </div>
          </button>

          <button
            type="button"
            data-testid="home-active-session"
            onClick={() => onSelectTab("chat")}
            className="text-left bg-[#0b1022] hover:bg-[#0e152e] border border-[#1b2544] hover:border-sky-400/40 rounded-xl p-4 transition-colors space-y-2"
          >
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-medium">Active Session</span>
              <MessageSquareCode className="w-4 h-4 text-violet-400 shrink-0" />
            </div>
            <div className="text-sm font-semibold text-white truncate">
              {sessionLabel}
            </div>
            <div className="text-xs font-mono text-slate-400 flex items-center gap-1.5 tabular-nums truncate">
              <span className="text-slate-300">{modelLabel}</span>
              <span aria-hidden="true">·</span>
              <span>
                {messageCount} {messageCount === 1 ? "message" : "messages"}
              </span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onSelectTab(apiKeyConfigured ? "context" : "setup")}
            className="text-left bg-[#0b1022] hover:bg-[#0e152e] border border-[#1b2544] hover:border-sky-400/40 rounded-xl p-4 transition-colors space-y-2"
          >
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-medium">Provider &amp; Context</span>
              {apiKeyConfigured ? (
                <KeyRound className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <Container className="w-4 h-4 text-amber-400 shrink-0" />
              )}
            </div>
            <div className="text-sm font-semibold text-white font-mono truncate">
              {!runtimeStatus
                ? "Google Gemini"
                : apiKeyConfigured
                  ? "Gemini Key Ready"
                  : "API Key Missing"}
            </div>
            <div className="text-xs font-mono text-slate-400 flex items-center gap-1.5 truncate">
              <span>GEMINI.md {projCtx?.hasGeminiMd ? "loaded" : "unset"}</span>
              <span aria-hidden="true">·</span>
              <span>MEMORY.md {projCtx?.hasMemoryMd ? "loaded" : "empty"}</span>
            </div>
          </button>
        </section>

        {/* Runtime Remediation Notice when Sandbox Is Not Ready */}
        {runtimeStatus && !isHostMode && !sandboxReady && (
          <section
            role="alert"
            data-testid="home-runtime-warning"
            className="bg-rose-950/35 border border-rose-500/40 rounded-xl p-4 md:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-rose-300 font-mono text-xs sm:text-sm font-semibold">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>
                  {runtimeAvailable
                    ? "Sandbox image missing — container runtime not ready"
                    : "Container runtime unavailable (Docker or Podman required)"}
                </span>
              </div>
              <p className="text-xs text-rose-100/90 leading-relaxed">
                {runtimeInfo?.error ||
                  "Neither Docker nor Podman is currently available. Sandbox execution fails closed until a container runtime and image are ready."}
              </p>
              {runtimeInfo?.remediation && (
                <p className="text-xs text-amber-200/90 font-mono">{runtimeInfo.remediation}</p>
              )}
            </div>
            <button
              type="button"
              data-testid="home-runtime-setup-action"
              onClick={() => onSelectTab("setup")}
              className="px-3.5 py-2 bg-rose-500 hover:bg-rose-400 text-slate-950 font-semibold rounded-lg text-xs whitespace-nowrap shrink-0 flex items-center gap-1.5"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Setup &amp; Status</span>
            </button>
          </section>
        )}

        {/* Starter Tasks */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-white">Start a Sandboxed Task</h2>
              <p className="text-xs text-slate-400">
                Load a starter prompt into the Agent Chat composer to inspect, test, or build inside{" "}
                <code className="font-mono text-slate-300">{workspacePathLabel}</code>.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onSelectTab("chat")}
              className="text-xs font-medium text-sky-400 hover:text-sky-300 whitespace-nowrap shrink-0 flex items-center gap-1"
            >
              <span>Custom prompt</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {STARTER_PROMPTS.map((item) => (
              <button
                key={item.title}
                type="button"
                data-testid="home-starter-prompt"
                onClick={() => onTryPrompt(item.prompt)}
                className="group text-left bg-[#0b1022] hover:bg-[#101833] border border-[#1b2544] hover:border-sky-400/45 rounded-xl p-4 transition-colors flex flex-col justify-between gap-2.5"
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-100 group-hover:text-white">
                      {item.title}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-sky-400 transition-transform group-hover:translate-x-0.5 shrink-0" />
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">{item.detail}</p>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500">
                  <span className="text-sky-400/90">{item.category}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{item.prompt}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Workbench Modules */}
        <section className="space-y-3 pb-2">
          <div>
            <h2 className="text-base font-semibold text-white">Workbench Tools</h2>
            <p className="text-xs text-slate-400">
              Jump directly to any workspace surface for {projectName}.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {WORKBENCH_MODULES.map((mod) => {
              const Icon = mod.icon;
              return (
                <button
                  key={mod.tab}
                  type="button"
                  data-testid={mod.tab === "setup" ? "home-setup-status" : `home-module-${mod.tab}`}
                  onClick={() => onSelectTab(mod.tab)}
                  className="group text-left bg-[#080c1a] hover:bg-[#0e152e] border border-[#1b2544] hover:border-[#2c3d70] rounded-xl p-4 transition-colors space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="w-8 h-8 rounded-lg bg-[#0f1733] border border-[#222e52] flex items-center justify-center text-sky-400">
                      <Icon className="w-4 h-4" />
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-slate-300 transition-colors" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-semibold text-slate-100">{mod.title}</div>
                    <p className="text-xs text-slate-400 leading-relaxed">{mod.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};
