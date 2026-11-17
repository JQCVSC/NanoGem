import React from "react";
import {
  Terminal,
  FolderTree,
  MessageSquareCode,
  Box,
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
} from "lucide-react";
import { RuntimeStatus } from "../types";

export type AppTab =
  | "chat"
  | "files"
  | "context"
  | "git"
  | "schedules"
  | "workflows"
  | "terminal"
  | "export";

interface HeaderProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  onResetWorkspace: () => void;
  onOpenSettings: () => void;
  onOpenAuth: () => void;
  runtimeStatus: RuntimeStatus | null;
  isExecuting: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  onResetWorkspace,
  onOpenSettings,
  onOpenAuth,
  runtimeStatus,
  isExecuting,
}) => {
  const isHostMode = runtimeStatus?.executionMode === "host";
  const dockerReady = Boolean(runtimeStatus?.docker?.available && runtimeStatus?.docker?.imagePresent);

  return (
    <header className="bg-slate-900 border-b border-slate-800 text-slate-100 px-4 py-3 sticky top-0 z-30 shadow-md">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Brand & Sandbox Status */}
        <div className="flex items-center space-x-3">
          <div className="bg-emerald-500/10 border border-emerald-500/30 p-2 rounded-lg flex items-center justify-center text-emerald-400">
            <Box className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="font-mono text-lg font-bold tracking-tight text-slate-100">
                Nano<span className="text-emerald-400">Gemini</span>
              </h1>
              {isHostMode ? (
                <span
                  title="NANOGEM_EXECUTION_MODE=host is active (no Docker isolation)"
                  className="px-2 py-0.5 text-xs font-mono bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded-full flex items-center gap-1"
                >
                  <ShieldAlert className="w-3 h-3" /> Host Mode (Unsafe)
                </span>
              ) : runtimeStatus && !dockerReady ? (
                <span
                  title={runtimeStatus.docker?.error || "Docker daemon or sandbox image unavailable"}
                  className="px-2 py-0.5 text-xs font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30 rounded-full flex items-center gap-1"
                >
                  <ShieldAlert className="w-3 h-3" /> Docker Not Ready
                </span>
              ) : (
                <span className="px-2 py-0.5 text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-full flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" /> Docker Sandboxed
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 font-mono">
              Workspace: <code className="text-slate-300">/workspace/</code> | Agent Status:{" "}
              {isExecuting ? (
                <span className="text-amber-400 font-semibold animate-pulse">Running tools...</span>
              ) : (
                <span className="text-emerald-400 font-semibold">Idle & Ready</span>
              )}
            </p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs font-mono">
          <button
            onClick={() => setActiveTab("chat")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "chat"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <MessageSquareCode className="w-4 h-4" />
            Agent Chat
          </button>

          <button
            onClick={() => setActiveTab("files")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "files"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <FolderTree className="w-4 h-4" />
            Workspace Files
          </button>

          <button
            onClick={() => setActiveTab("context")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "context"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <BookOpen className="w-4 h-4" />
            Instructions &amp; Memory
          </button>

          <button
            onClick={() => setActiveTab("git")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "git"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <FileDiff className="w-4 h-4" />
            Review Changes
          </button>

          <button
            onClick={() => setActiveTab("schedules")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "schedules"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <Clock className="w-4 h-4" />
            Schedules
          </button>

          <button
            onClick={() => setActiveTab("workflows")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "workflows"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            Workflows
          </button>

          <button
            onClick={() => setActiveTab("terminal")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "terminal"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <Terminal className="w-4 h-4" />
            Terminal Console
          </button>

          <button
            onClick={() => setActiveTab("export")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "export"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <Download className="w-4 h-4" />
            Source & Export
          </button>
        </nav>

        {/* Global Action Tools */}
        <div className="flex items-center space-x-2">
          <button
            onClick={onResetWorkspace}
            title="Reset Sandbox Workspace"
            className="p-2 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Reset Sandbox</span>
          </button>

          {runtimeStatus?.authRequired && (
            <button
              onClick={onOpenAuth}
              title="Set API Authentication Token"
              className="p-2 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              <Lock className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Token</span>
            </button>
          )}

          <button
            onClick={onOpenSettings}
            title="Agent System Settings"
            className="p-2 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Config</span>
          </button>
        </div>
      </div>
    </header>
  );
};
