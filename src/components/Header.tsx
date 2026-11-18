import React, { useState, useRef, useEffect } from "react";
import {
  Terminal,
  FolderTree,
  MessageSquareCode,
  Settings,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Lock,
  Download,
  BookOpen,
  FileDiff,
  Clock,
  FileSpreadsheet,
  Activity,
  ChevronDown,
  Folder,
  FolderPlus,
  History,
  MessageSquarePlus,
  Menu,
  X,
  ArrowUpRight,
  Check,
} from "lucide-react";
import { ProjectSummary, RuntimeStatus, SessionSummary } from "../types";

export type AppTab =
  | "chat"
  | "files"
  | "context"
  | "git"
  | "schedules"
  | "workflows"
  | "setup"
  | "terminal"
  | "export";

interface HeaderProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  onRequestResetWorkspace: () => void;
  onOpenSettings: () => void;
  onOpenAuth: () => void;
  runtimeStatus: RuntimeStatus | null;
  projects: ProjectSummary[];
  activeProjectId: string;
  onSelectProject: (projectId: string) => void;
  onOpenNewProject: () => void;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onStartNewSession: () => void;
  isExecuting: boolean;
}

const PRIMARY_TABS: Array<{ id: AppTab; label: string; icon: React.FC<{ className?: string }> }> = [
  { id: "chat", label: "Agent", icon: MessageSquareCode },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "context", label: "Memory", icon: BookOpen },
  { id: "git", label: "Review", icon: FileDiff },
];

const MORE_TABS: Array<{
  id: AppTab;
  label: string;
  icon: React.FC<{ className?: string }>;
}> = [
  { id: "terminal", label: "Terminal Console", icon: Terminal },
  { id: "schedules", label: "Schedules & Jobs", icon: Clock },
  { id: "workflows", label: "Workflows", icon: FileSpreadsheet },
  { id: "setup", label: "Setup & Status", icon: Activity },
  { id: "export", label: "Source & Export", icon: Download },
];

function formatImageId(image?: string): string {
  if (!image) return "nanogem-sandbox:latest";
  const shaMatch = image.match(/(sha256:|sha-)([a-f0-9]+)/i);
  if (shaMatch) {
    return `${shaMatch[1]}${shaMatch[2].slice(0, 12)}`;
  }
  return image.length > 26 ? `${image.slice(0, 24)}…` : image;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  onRequestResetWorkspace,
  onOpenSettings,
  onOpenAuth,
  runtimeStatus,
  projects,
  activeProjectId,
  onSelectProject,
  onOpenNewProject,
  sessions,
  activeSessionId,
  onSelectSession,
  onStartNewSession,
  isExecuting,
}) => {
  const [openMenu, setOpenMenu] = useState<"project" | "runtime" | "more" | "mobile" | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const runtimeInfo = runtimeStatus?.containerRuntime ?? runtimeStatus?.docker;
  const isHostMode = runtimeStatus?.executionMode === "host";
  const dockerReady = Boolean(runtimeInfo?.available && runtimeInfo?.imagePresent);
  const selectedRuntime = runtimeInfo?.selectedRuntime;
  const networkEnabled = Boolean(runtimeInfo?.networkEnabled);
  const uncommittedChanges = Boolean(runtimeStatus?.projectContext?.hasUncommittedChanges);
  const branchName = runtimeStatus?.projectContext?.branch || (runtimeStatus?.projectContext?.isGitRepo ? "main" : null);

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const projectLabel = activeProject?.name || activeProjectId || "default";
  const workspaceLabel = activeProject?.slug ? `/workspace/${activeProject.slug}` : "/workspace";

  const isMoreActive = MORE_TABS.some((t) => t.id === activeTab);
  const activeMoreItem = MORE_TABS.find((t) => t.id === activeTab);

  let statusLabel = "Podman Sandboxed";
  let statusClasses =
    "bg-[#0b2420] text-emerald-400 border-emerald-500/30 hover:border-emerald-500/60";
  let StatusIcon = ShieldCheck;

  if (isHostMode) {
    statusLabel = "Host Mode (Unsafe)";
    statusClasses =
      "bg-amber-950/40 text-amber-300 border-amber-500/30 hover:border-amber-400/60";
    StatusIcon = ShieldAlert;
  } else if (runtimeStatus && !dockerReady) {
    statusLabel = runtimeInfo?.available ? "Image Missing" : "Runtime Not Ready";
    statusClasses =
      "bg-rose-950/40 text-rose-300 border-rose-500/30 hover:border-rose-400/60";
    StatusIcon = ShieldAlert;
  } else if (selectedRuntime === "docker") {
    statusLabel = "Docker Sandboxed";
  }

  const runtimeDisplay = isHostMode
    ? "Host (Direct)"
    : `${selectedRuntime === "docker" ? "Docker" : "Podman"}${
        runtimeInfo?.serverVersion ? ` v${runtimeInfo.serverVersion}` : ""
      }`;

  const selectTab = (tab: AppTab) => {
    setActiveTab(tab);
    setOpenMenu(null);
  };

  return (
    <header
      ref={headerRef}
      className="w-full bg-[#090e1f] border-b border-[#1b2544] px-4 lg:px-5 py-2.5 text-xs sticky top-0 z-30 relative"
    >
      <div className="nanogem-prism-line h-[2px] w-full absolute top-0 left-0 opacity-90" aria-hidden="true" />
      <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-3">
        {/* Left Zone: Logo, Project/Session Switcher & Runtime Inspector */}
        <div className="flex items-center gap-2.5 min-w-0 shrink-0">
          {/* Logo */}
          <button
            type="button"
            onClick={() => selectTab("chat")}
            className="flex items-center gap-2.5 whitespace-nowrap shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded-lg"
          >
            <div aria-label="NanoGem Logo" className="flex items-center justify-center shrink-0">
              {!logoFailed ? (
                <img
                  src="https://i.imgur.com/GEboDT3.png"
                  alt="NanoGem Logo"
                  referrerPolicy="no-referrer"
                  onError={() => setLogoFailed(true)}
                  className="h-8 w-auto max-w-[38px] object-contain drop-shadow-[0_0_10px_rgba(56,189,248,0.28)]"
                />
              ) : (
                <span className="w-8 h-8 rounded-lg bg-[#111936] border border-sky-400/40 flex items-center justify-center text-sky-300 font-mono text-xs font-bold">
                  NG
                </span>
              )}
            </div>
            <span className="text-white font-bold text-sm tracking-tight font-mono">
              Nano<span className="nanogem-wordmark-gradient">Gem</span>
            </span>
          </button>

          <span className="text-slate-600 hidden sm:inline">/</span>

          {/* Project & Session Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === "project" ? null : "project")}
              aria-expanded={openMenu === "project"}
              aria-haspopup="dialog"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#0e152b] hover:bg-[#152042] border border-[#222e52] text-slate-200 text-xs font-mono transition-colors whitespace-nowrap shrink-0"
            >
              <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="font-medium text-slate-100 max-w-[130px] truncate">
                {projectLabel}
              </span>
              {branchName && (
                <span className="hidden lg:inline text-[11px] text-slate-400">
                  · {branchName}
                </span>
              )}
              <ChevronDown
                className={`w-3 h-3 text-slate-400 transition-transform duration-150 ${
                  openMenu === "project" ? "rotate-180" : ""
                }`}
              />
            </button>

            {openMenu === "project" && (
              <div
                role="dialog"
                aria-label="Project and session selector"
                className="absolute left-0 top-full mt-2 w-72 bg-[#0b1022] border border-[#24325c] rounded-xl p-3 shadow-2xl z-50 space-y-3"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span className="font-semibold text-slate-200">Projects</span>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        onOpenNewProject();
                      }}
                      disabled={isExecuting}
                      className="text-sky-400 hover:text-sky-300 flex items-center gap-1 font-medium"
                    >
                      <FolderPlus className="w-3 h-3" />
                      <span>New Project</span>
                    </button>
                  </div>
                  <div className="max-h-36 overflow-y-auto space-y-1">
                    {projects.map((p) => {
                      const active = p.id === activeProjectId;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          disabled={isExecuting}
                          onClick={() => {
                            onSelectProject(p.id);
                            setOpenMenu(null);
                          }}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono flex items-center justify-between transition-colors ${
                            active
                              ? "bg-sky-500/15 text-sky-300 border border-sky-400/35"
                              : "text-slate-300 hover:bg-[#152042]"
                          }`}
                        >
                          <span className="truncate">{p.name}</span>
                          {active && <Check className="w-3.5 h-3.5 shrink-0 text-sky-400" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-[#1b2544] pt-2.5 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span className="font-semibold text-slate-200 flex items-center gap-1">
                      <History className="w-3 h-3 text-violet-400" />
                      Sessions
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onStartNewSession();
                        setOpenMenu(null);
                      }}
                      disabled={isExecuting}
                      className="text-sky-400 hover:text-sky-300 flex items-center gap-1 font-medium"
                    >
                      <MessageSquarePlus className="w-3 h-3" />
                      <span>New Session</span>
                    </button>
                  </div>
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {sessions.map((s) => {
                      const active = s.id === activeSessionId;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          disabled={isExecuting}
                          onClick={() => {
                            onSelectSession(s.id);
                            setOpenMenu(null);
                          }}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                            active
                              ? "bg-[#152042] text-white font-medium"
                              : "text-slate-400 hover:bg-[#152042] hover:text-slate-200"
                          }`}
                        >
                          <span className="truncate">{s.title}</span>
                          {active && <Check className="w-3 h-3 shrink-0 text-sky-400" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Interactive Podman / Docker Sandboxed Trigger with Runtime Inspector Popover */}
          <div className="relative hidden sm:block">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === "runtime" ? null : "runtime")}
              aria-expanded={openMenu === "runtime"}
              aria-haspopup="dialog"
              className={`inline-flex items-center px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors gap-1.5 whitespace-nowrap shrink-0 ${statusClasses}`}
            >
              <StatusIcon className="w-3 h-3 shrink-0" />
              <span>{statusLabel}</span>
              <ChevronDown
                className={`w-3 h-3 opacity-75 transition-transform duration-150 ${
                  openMenu === "runtime" ? "rotate-180" : ""
                }`}
              />
            </button>

            {openMenu === "runtime" && (
              <div
                role="dialog"
                aria-label="Sandbox runtime details"
                className="flex flex-col absolute left-0 top-full mt-2 w-72 bg-[#0b1022] border border-sky-400/40 rounded-xl p-3.5 shadow-2xl z-50 text-[11px] font-mono backdrop-blur-md"
              >
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#1b2544]">
                  <span className="text-white font-semibold">Sandbox Runtime Details</span>
                  <span
                    className={`text-[10px] font-medium ${
                      isHostMode
                        ? "text-amber-300"
                        : dockerReady
                          ? "text-emerald-400"
                          : "text-rose-400"
                    }`}
                  >
                    {isHostMode ? "Unisolated" : dockerReady ? "Enforced" : "Needs Setup"}
                  </span>
                </div>

                <div className="space-y-1.5 text-slate-300 tabular-nums">
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Runtime:</span>
                    <span className="text-slate-200 font-medium text-right">{runtimeDisplay}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Execution:</span>
                    <span className={isHostMode ? "text-amber-300" : "text-emerald-400"}>
                      {isHostMode ? "Host (Direct)" : "Containerized"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Network:</span>
                    <span className={networkEnabled || isHostMode ? "text-amber-300" : "text-emerald-400"}>
                      {isHostMode ? "Host" : networkEnabled ? "Enabled" : "Disabled (Isolated)"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Image:</span>
                    <span
                      className="text-slate-300 truncate max-w-[165px]"
                      title={runtimeInfo?.image || "nanogem-sandbox:latest"}
                    >
                      {formatImageId(runtimeInfo?.image)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Workspace:</span>
                    <span className="text-sky-400 truncate max-w-[165px]" title={workspaceLabel}>
                      {workspaceLabel}
                    </span>
                  </div>
                </div>

                <div className="pt-2.5 mt-2.5 border-t border-[#1b2544] flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => selectTab("setup")}
                    className="text-sky-400 hover:text-sky-300 flex items-center gap-1 font-sans font-medium"
                  >
                    <span>Setup &amp; Status</span>
                    <ArrowUpRight className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpenMenu(null)}
                    className="text-slate-400 hover:text-slate-200 font-sans"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Center Navigation Tabs: Agent, Files, Memory, Review, More */}
        <nav
          aria-label="Workspace Views"
          className="hidden md:flex items-center bg-[#060914] p-1 rounded-lg border border-[#1b2544] gap-1 shrink-0"
        >
          {PRIMARY_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => selectTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? "text-sky-300 bg-[#121c3a] border border-sky-400/40 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 hover:bg-[#101830] border border-transparent"
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span>{tab.label}</span>
                {tab.id === "git" && uncommittedChanges && (
                  <span className="text-amber-400 font-mono" title="Uncommitted changes">
                    *
                  </span>
                )}
              </button>
            );
          })}

          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === "more" ? null : "more")}
              aria-expanded={openMenu === "more"}
              aria-haspopup="menu"
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                isMoreActive
                  ? "text-sky-300 bg-[#121c3a] border border-sky-400/40 shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-[#101830] border border-transparent"
              }`}
            >
              <span>{activeMoreItem ? activeMoreItem.label : "More"}</span>
              <ChevronDown
                className={`w-3 h-3 text-slate-400 transition-transform duration-150 ${
                  openMenu === "more" ? "rotate-180" : ""
                }`}
              />
            </button>

            {openMenu === "more" && (
              <div
                role="menu"
                aria-label="Additional tools"
                className="flex flex-col absolute right-0 top-full mt-1.5 w-48 bg-[#0b1022] border border-[#222e52] rounded-lg shadow-xl p-1 z-50"
              >
                {MORE_TABS.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      onClick={() => selectTab(item.id)}
                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded text-xs transition-colors text-left ${
                        isActive
                          ? "bg-[#152042] text-sky-300 font-medium"
                          : "text-slate-300 hover:bg-[#152042] hover:text-white"
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </nav>

        {/* Right Utility Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Agent Status Indicator */}
          <div className="hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#0b1022] border border-[#1b2544] text-[11px] font-mono whitespace-nowrap">
            <span className="text-slate-400">Agent:</span>
            <span className={isExecuting ? "text-amber-400 font-medium" : "text-emerald-400 font-medium"}>
              {isExecuting ? "Running task…" : "Idle & Ready"}
            </span>
          </div>

          <button
            type="button"
            onClick={onRequestResetWorkspace}
            title="Reset Sandbox Workspace"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#0e152b] hover:bg-[#162142] text-slate-300 hover:text-white border border-[#222e52] transition-colors text-xs whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="hidden lg:inline">Reset Sandbox</span>
          </button>

          {runtimeStatus?.authRequired && (
            <button
              type="button"
              onClick={onOpenAuth}
              title="Manage API Token"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#0e152b] hover:bg-[#162142] text-slate-300 hover:text-white border border-[#222e52] transition-colors text-xs whitespace-nowrap shrink-0"
            >
              <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="hidden lg:inline">Token</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenSettings}
            title="Configuration & Instructions"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#0e152b] hover:bg-[#162142] text-slate-300 hover:text-white border border-[#222e52] transition-colors text-xs whitespace-nowrap shrink-0"
          >
            <Settings className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="hidden sm:inline">Config</span>
          </button>

          {/* Mobile Menu Toggle */}
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === "mobile" ? null : "mobile")}
            aria-label="Toggle navigation menu"
            aria-expanded={openMenu === "mobile"}
            className="md:hidden p-1.5 rounded-md bg-[#0e152b] hover:bg-[#162142] text-slate-200 border border-[#222e52] shrink-0"
          >
            {openMenu === "mobile" ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation Drawer */}
      {openMenu === "mobile" && (
        <div className="md:hidden border-t border-[#1b2544] mt-2.5 pt-2.5 grid grid-cols-2 gap-1.5">
          {[...PRIMARY_TABS, ...MORE_TABS].map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => selectTab(item.id)}
                className={`px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2 text-left transition-colors ${
                  isActive
                    ? "bg-[#121c3a] text-sky-300 border border-sky-400/40"
                    : "text-slate-300 hover:bg-[#101830]"
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </header>
  );
};
