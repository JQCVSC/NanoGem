import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  Terminal,
  FileCode,
  Bot,
  User,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Loader2,
  Copy,
  Check,
  BookmarkPlus,
  Zap,
  Lock,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import {
  AgentProgressEvent,
  AgentRequestError,
  ChatMessage,
  ExecutionStep,
  ProjectSummary,
  RuntimeStatus,
} from "../types";

interface AgentChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => Promise<boolean> | boolean | void;
  onSaveToMemory?: (text: string) => Promise<void>;
  isExecuting: boolean;
  progressEvents?: AgentProgressEvent[];
  onSelectTab: (tab: "files" | "terminal") => void;
  projects: ProjectSummary[];
  activeProjectId: string;
  onSelectProject: (projectId: string) => void;
  onOpenNewProject: () => void;
  runtimeStatus: RuntimeStatus | null;
  draftPrompt?: string | null;
  onConsumeDraftPrompt?: () => void;
  lastError?: AgentRequestError | null;
  onRetry?: () => Promise<boolean> | boolean | void;
  onDismissError?: () => void;
}

const SAMPLE_PROMPTS = [
  {
    prompt: "Build a Node.js REST API with Express and health tests",
    category: "Backend",
    tag: "Express",
  },
  {
    prompt: "Inspect repository files and summarize architecture",
    category: "Analysis",
    tag: "Docs",
  },
  {
    prompt: "Write a Python script for data processing and run tests",
    category: "Python",
    tag: "Pytest",
  },
  {
    prompt: "Audit security dependencies and fix vulnerable packages",
    category: "Security",
    tag: "Audit",
  },
];

const SLASH_CHIPS = [
  { label: "/test", insert: "Run the project test suite inside /workspace and report the results." },
  { label: "/diff", insert: "Inspect git status and summarize uncommitted changes in /workspace." },
  { label: "/exec", insert: "Run a diagnostic check in /workspace: " },
  { label: "/explain", insert: "Explain the architecture and entry points of the current project." },
];

const DESTRUCTIVE_PATTERN =
  /\b(rm\s+-[a-z]*[rf]|rmdir|unlink|shred|mkfs|dd\s+if=|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|drop\s+table|drop\s+database|truncate\s+table|delete\s+all|wipe\s+workspace|reset\s+sandbox|destroy\s+all|format\s+disk)\b/i;

export const AgentChat: React.FC<AgentChatProps> = ({
  messages,
  onSendMessage,
  onSaveToMemory,
  isExecuting,
  progressEvents = [],
  onSelectTab,
  projects,
  activeProjectId,
  onSelectProject,
  onOpenNewProject,
  runtimeStatus,
  draftPrompt = null,
  onConsumeDraftPrompt,
  lastError = null,
  onRetry,
  onDismissError,
}) => {
  const [input, setInput] = useState("");
  const [savedMsgIds, setSavedMsgIds] = useState<Record<string, boolean>>({});
  const [pendingDestructivePrompt, setPendingDestructivePrompt] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const localSubmitGuardRef = useRef(false);

  useEffect(() => {
    if (draftPrompt) {
      setInput(draftPrompt);
      textareaRef.current?.focus();
      onConsumeDraftPrompt?.();
    }
  }, [draftPrompt, onConsumeDraftPrompt]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages, isExecuting]);

  const runtimeInfo = runtimeStatus?.containerRuntime ?? runtimeStatus?.docker;
  const isHostMode = runtimeStatus?.executionMode === "host";
  const selectedRuntime = runtimeInfo?.selectedRuntime;
  const runtimeLabel = isHostMode
    ? "Host Execution Active"
    : selectedRuntime === "docker"
      ? "Docker Rootless Container"
      : "Podman Rootless Container";

  const sandboxTrustNote = isHostMode
    ? "Commands run directly on the host (isolation disabled) · Destructive file writes require confirmation"
    : selectedRuntime === "docker"
      ? "Commands run in the isolated Docker sandbox · Destructive file writes require confirmation"
      : "Commands run in the isolated Podman sandbox · Destructive file writes require confirmation";

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const workspacePathLabel = activeProject?.slug
    ? `/workspace/${activeProject.slug}`
    : "/workspace";
  const branchLabel = runtimeStatus?.projectContext?.branch || "main";

  const attemptSubmit = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || isExecuting || localSubmitGuardRef.current) return;

    if (DESTRUCTIVE_PATTERN.test(trimmed)) {
      setPendingDestructivePrompt(trimmed);
      return;
    }

    localSubmitGuardRef.current = true;
    setInput(trimmed);
    setPendingDestructivePrompt(null);
    try {
      const succeeded = await onSendMessage(trimmed);
      if (succeeded !== false) {
        setInput("");
      }
    } finally {
      localSubmitGuardRef.current = false;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void attemptSubmit(input);
  };

  const handleConfirmDestructive = async () => {
    if (!pendingDestructivePrompt || isExecuting || localSubmitGuardRef.current) return;
    const confirmed = pendingDestructivePrompt;
    localSubmitGuardRef.current = true;
    setInput(confirmed);
    setPendingDestructivePrompt(null);
    try {
      const succeeded = await onSendMessage(confirmed);
      if (succeeded !== false) {
        setInput("");
      }
    } finally {
      localSubmitGuardRef.current = false;
    }
  };

  const handleRetryClick = async () => {
    if (!onRetry || isExecuting || localSubmitGuardRef.current) return;
    localSubmitGuardRef.current = true;
    try {
      const succeeded = await onRetry();
      if (succeeded !== false) {
        setInput("");
      }
    } finally {
      localSubmitGuardRef.current = false;
    }
  };

  const handleCancelDestructive = () => {
    setPendingDestructivePrompt(null);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      attemptSubmit(input);
    }
  };

  const handleSlashChip = (insertText: string) => {
    setInput(insertText);
    setPendingDestructivePrompt(null);
    textareaRef.current?.focus();
  };

  return (
    <div className="flex flex-col h-full bg-[#050811] text-slate-300">
      {/* Main Scrollable Viewport (Empty State Card OR Conversation Thread) */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 flex flex-col">
        {messages.length === 0 ? (
          <div className="m-auto w-full max-w-2xl bg-[#090d18] border border-[#161f36] rounded-2xl p-6 md:p-8 shadow-2xl flex flex-col items-center text-center">
            {/* Center Brand Mark */}
            <div className="mb-5 flex items-center justify-center">
              {!logoFailed ? (
                <img
                  src="https://i.imgur.com/GEboDT3.png"
                  alt="NanoGem Logo"
                  referrerPolicy="no-referrer"
                  onError={() => setLogoFailed(true)}
                  className="h-20 w-auto max-w-[200px] object-contain drop-shadow-[0_0_20px_rgba(16,185,129,0.25)]"
                />
              ) : (
                <div className="w-16 h-16 rounded-2xl bg-[#0e1726] border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-[0_0_24px_rgba(16,185,129,0.2)]">
                  <svg
                    className="w-8 h-8"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" x2="12" y1="22.08" y2="12" />
                  </svg>
                </div>
              )}
            </div>

            {/* Headline & Subtitle */}
            <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight font-mono mb-2 text-balance">
              What are you building today?
            </h1>
            <p className="text-xs md:text-sm text-slate-400 leading-relaxed max-w-lg mb-4">
              Ask Gemini to inspect, change, test, or explain your project inside an isolated{" "}
              {isHostMode ? "workspace" : selectedRuntime === "docker" ? "Docker" : "Podman"} sandbox.
            </p>

            {/* Active Project Context Strip */}
            <div className="relative mb-6">
              <div className="flex flex-wrap items-center justify-center gap-2 bg-[#060a13] border border-[#141e33] px-3 py-1.5 rounded-lg text-xs font-mono text-slate-400">
                <span className="text-slate-500">Active Project:</span>
                <span className="text-emerald-400 font-medium">{workspacePathLabel}</span>
                {runtimeStatus?.projectContext?.isGitRepo && (
                  <>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span className="text-slate-300">
                      branch: <span className="text-white font-medium">{branchLabel}</span>
                    </span>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setIsProjectMenuOpen((v) => !v)}
                  className="text-emerald-400 hover:text-emerald-300 ml-1 hover:underline text-[11px] font-medium"
                >
                  + Switch
                </button>
              </div>

              {isProjectMenuOpen && (
                <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-64 bg-[#090e1c] border border-[#1b2b48] rounded-xl p-2 shadow-2xl z-40 text-left space-y-1">
                  <div className="px-2 py-1 text-[11px] font-medium text-slate-400 flex items-center justify-between">
                    <span>Select a project</span>
                    <button
                      type="button"
                      onClick={() => {
                        setIsProjectMenuOpen(false);
                        onOpenNewProject();
                      }}
                      className="text-emerald-400 hover:text-emerald-300 font-medium"
                    >
                      + Create project
                    </button>
                  </div>
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        onSelectProject(p.id);
                        setIsProjectMenuOpen(false);
                      }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono flex items-center justify-between transition-colors ${
                        p.id === activeProjectId
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "text-slate-300 hover:bg-[#121c32]"
                      }`}
                    >
                      <span className="truncate">{p.name}</span>
                      {p.id === activeProjectId && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Suggested Prompts Divider */}
            <div className="w-full flex items-center justify-center my-1 relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[#141e33]" />
              </div>
              <div className="relative bg-[#090d18] px-3.5 flex items-center gap-1.5 text-[11px] text-amber-400/90 font-mono font-semibold">
                <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Suggested Task Prompts</span>
              </div>
            </div>

            {/* 2x2 Suggested Prompts Grid */}
            <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-3 mt-5 text-left">
              {SAMPLE_PROMPTS.map((item, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => attemptSubmit(item.prompt)}
                  disabled={isExecuting}
                  className="group bg-[#060a13] hover:bg-[#0c1424] border border-[#162035] hover:border-emerald-500/40 rounded-xl p-3.5 transition-all text-left flex flex-col justify-between gap-2"
                >
                  <div className="flex items-start gap-2">
                    <span className="text-emerald-400 font-mono text-xs font-bold mt-0.5 leading-none transition-transform group-hover:translate-x-0.5">
                      &gt;
                    </span>
                    <span className="text-xs text-slate-300 group-hover:text-white leading-snug font-mono">
                      {item.prompt}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 pl-4 text-[11px] font-mono text-slate-500">
                    <span>{item.category}</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-emerald-400/80">{item.tag}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-4xl w-full mx-auto space-y-6 py-2">
            {messages.map((msg) => (
              <div key={msg.id} className="space-y-2.5">
                <div className="flex items-center gap-2">
                  {msg.role === "user" ? (
                    <div className="w-7 h-7 rounded-lg bg-blue-600/15 border border-blue-500/30 text-blue-400 flex items-center justify-center shrink-0">
                      <User className="w-4 h-4" />
                    </div>
                  ) : (
                    <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shrink-0">
                      <Bot className="w-4 h-4" />
                    </div>
                  )}
                  <span className="text-xs font-semibold text-slate-200">
                    {msg.role === "user" ? "You" : "NanoGem Agent"}
                  </span>
                  {msg.role === "assistant" && msg.modelUsed && (
                    <span
                      data-testid="message-model-badge"
                      className={`px-2 py-0.5 rounded-md text-[11px] font-mono border ${
                        msg.fallbackUsed
                          ? "bg-amber-950/40 text-amber-300 border-amber-500/40"
                          : "bg-[#0c1424] text-slate-300 border-[#1b2b48]"
                      }`}
                    >
                      {msg.fallbackUsed
                        ? `Model: ${msg.modelUsed} (fallback from ${msg.configuredModel || "primary"})`
                        : `Model: ${msg.modelUsed}`}
                    </span>
                  )}
                  <span className="text-xs text-slate-500 tabular-nums font-mono">
                    {msg.timestamp}
                  </span>
                  {msg.role === "assistant" && onSaveToMemory && msg.content && (
                    <button
                      type="button"
                      onClick={async () => {
                        await onSaveToMemory(msg.content);
                        setSavedMsgIds((prev) => ({ ...prev, [msg.id]: true }));
                      }}
                      className="ml-auto px-2.5 py-1 bg-[#090d18] hover:bg-[#121c32] border border-[#162035] text-slate-300 hover:text-emerald-300 rounded-md text-xs flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                    >
                      {savedMsgIds[msg.id] ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Saved to MEMORY.md</span>
                        </>
                      ) : (
                        <>
                          <BookmarkPlus className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Save to Memory</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                <div className="p-4 rounded-xl bg-[#090d18] border border-[#161f36] text-slate-200 ml-9 text-sm leading-relaxed">
                  {msg.content && (
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                  )}

                  {msg.executionSteps && msg.executionSteps.length > 0 && (
                    <div className="mt-4 space-y-2.5 pt-3 border-t border-[#161f36]">
                      <p className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                        Sandbox Execution Log ({msg.executionSteps.length} action
                        {msg.executionSteps.length === 1 ? "" : "s"})
                      </p>

                      {msg.executionSteps.map((step, sIdx) => (
                        <ToolExecutionCard
                          key={sIdx}
                          step={step}
                          onSelectTab={onSelectTab}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Live Progress Timeline */}
        {isExecuting && (
          <div className="max-w-4xl w-full mx-auto mt-6">
            <div className="ml-9 bg-[#090d18] border border-emerald-500/30 p-4 rounded-xl text-xs space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>
                  {progressEvents.length > 0
                    ? progressEvents[progressEvents.length - 1].label
                    : "Analyzing request"}
                </span>
              </div>
              {progressEvents.length > 0 && (
                <ul className="space-y-1 pl-6 text-xs text-slate-300">
                  {progressEvents.map((ev) => (
                    <li key={ev.id} className="flex items-center gap-2">
                      <span
                        className={
                          ev.stage === "command_failed" || ev.stage === "error"
                            ? "text-rose-400"
                            : ev.stage === "finished" || ev.stage === "command_completed"
                              ? "text-emerald-400"
                              : "text-amber-400"
                        }
                      >
                        •
                      </span>
                      <span className="font-medium">{ev.label}</span>
                      {ev.detail && (
                        <code className="font-mono text-slate-400 truncate max-w-md">
                          {ev.detail}
                        </code>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Floating Command Bar */}
      <div className="w-full pb-4 pt-2 px-4 flex justify-center shrink-0">
        <form onSubmit={handleSubmit} className="w-full max-w-3xl flex flex-col space-y-2">
          {/* Structured Transient Error / Retry Banner */}
          {lastError && (
            <div
              role="alert"
              data-testid="agent-error-banner"
              className="bg-rose-950/40 border border-rose-500/40 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 text-xs">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="font-semibold text-rose-200">{lastError.error}</p>
                  <p className="text-[11px] font-mono text-slate-400">
                    {lastError.status ? `HTTP ${lastError.status}` : "Request failed"}
                    {lastError.code ? ` · ${lastError.code}` : ""}
                    {lastError.retryable ? " · Prompt preserved below." : ""}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {onDismissError && (
                  <button
                    type="button"
                    onClick={onDismissError}
                    disabled={isExecuting}
                    className="px-2.5 py-1.5 bg-[#0f172a] hover:bg-[#17233f] text-slate-300 rounded-lg text-xs font-medium"
                  >
                    Dismiss
                  </button>
                )}
                {lastError.retryable && onRetry && (
                  <button
                    type="button"
                    onClick={() => void handleRetryClick()}
                    disabled={isExecuting}
                    className="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Retry</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Destructive Confirmation State */}
          {pendingDestructivePrompt && (
            <div
              role="alertdialog"
              aria-label="Confirm destructive task"
              className="bg-amber-950/40 border border-amber-500/40 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 text-xs">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="font-semibold text-amber-200">
                    Confirm potentially destructive action
                  </p>
                  <p className="text-slate-300">
                    This request may delete or overwrite files inside{" "}
                    <code className="font-mono text-amber-200">/workspace</code>.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleCancelDestructive}
                  className="px-3 py-1.5 bg-[#0f172a] hover:bg-[#17233f] text-slate-200 rounded-lg text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDestructive}
                  className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg text-xs font-semibold"
                >
                  Confirm &amp; Execute
                </button>
              </div>
            </div>
          )}

          {/* Safety Execution Banner */}
          <div className="flex items-center justify-between px-3 py-1.5 bg-[#070b14] border border-[#151e33] rounded-lg text-[11px] font-mono text-slate-400">
            <div className="flex items-center gap-2 min-w-0 truncate">
              <span
                className={`font-medium ${
                  isHostMode ? "text-amber-400" : "text-emerald-400"
                }`}
              >
                {isHostMode ? "Host Execution Mode" : "Safe Execution Mode Active"}
              </span>
              <span className="text-slate-600" aria-hidden="true">—</span>
              <span className="text-slate-500 truncate">{runtimeLabel}</span>
            </div>
            <div className="flex items-center gap-1 text-slate-500 shrink-0">
              <span>Project:</span>
              <span className="text-slate-300 font-medium">
                {activeProject?.name || activeProjectId}
              </span>
            </div>
          </div>

          {/* Command Bar Card Container */}
          <div className="w-full bg-[#080d19]/95 border border-[#1b2b48] rounded-xl p-3 shadow-2xl backdrop-blur-md flex flex-col gap-2.5 focus-within:border-emerald-500/60 focus-within:shadow-[0_0_20px_rgba(16,185,129,0.15)] transition-all">
            <label htmlFor="agent-prompt-input" className="sr-only">
              Task prompt
            </label>
            <textarea
              ref={textareaRef}
              id="agent-prompt-input"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (pendingDestructivePrompt) setPendingDestructivePrompt(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask NanoGem to inspect, edit, test, or explain your project…"
              rows={2}
              disabled={isExecuting}
              className="w-full bg-transparent text-slate-200 placeholder-slate-500 text-xs md:text-sm font-mono focus:outline-none resize-none px-1 pt-0.5 leading-relaxed"
            />

            <div className="flex flex-wrap items-center justify-between pt-2 border-t border-[#141e33] gap-2">
              {/* Quick Slash Command Chips */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {SLASH_CHIPS.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    disabled={isExecuting}
                    onClick={() => handleSlashChip(chip.insert)}
                    className="px-2 py-0.5 rounded bg-[#0a0f1d] hover:bg-[#121c32] text-slate-400 hover:text-emerald-400 border border-[#162035] text-[11px] font-mono transition-colors"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>

              {/* Action helper & Execute Button */}
              <div className="flex items-center gap-3 shrink-0 ml-auto">
                <span className="text-[11px] text-slate-500 hidden sm:inline font-mono">
                  Shift + Enter for new line
                </span>
                <button
                  type="submit"
                  disabled={!input.trim() || isExecuting}
                  className="bg-emerald-500 hover:bg-emerald-400 disabled:bg-[#121c32] disabled:text-slate-500 text-slate-950 font-semibold border border-emerald-400 disabled:border-[#1b2b48] text-xs px-3.5 py-1.5 rounded-lg flex items-center gap-1.5 transition-all shadow-[0_0_12px_rgba(16,185,129,0.25)] disabled:shadow-none whitespace-nowrap shrink-0"
                >
                  {isExecuting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Running…</span>
                    </>
                  ) : (
                    <>
                      <span>Execute</span>
                      <Send className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Trust & Isolation Note */}
          <div className="text-center text-[11px] text-slate-500 font-mono flex items-center justify-center gap-1.5 pt-0.5">
            <Lock className="w-3 h-3 text-emerald-400/80 shrink-0" />
            <span>{sandboxTrustNote}</span>
          </div>
        </form>
      </div>
    </div>
  );
};

interface ToolExecutionCardProps {
  step: ExecutionStep;
  onSelectTab: (tab: "files" | "terminal") => void;
}

const ToolExecutionCard: React.FC<ToolExecutionCardProps> = ({
  step,
  onSelectTab,
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  if (step.type === "text_response" && !step.toolName) return null;

  const isCommand = step.toolName === "execute_system_command";
  const isFileWrite = step.toolName === "write_local_file";

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = step.output || step.text || "";
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-[#060a13] border border-[#162035] rounded-lg overflow-hidden font-mono text-xs">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2 bg-[#0b101d] hover:bg-[#121c32] flex items-center justify-between border-b border-[#162035] transition-colors text-left"
      >
        <div className="flex items-center gap-2 overflow-hidden min-w-0">
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          )}

          {isCommand && (
            <span className="text-[11px] text-blue-400 font-semibold flex items-center gap-1 shrink-0">
              <Terminal className="w-3 h-3" /> BASH
            </span>
          )}

          {isFileWrite && (
            <span className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1 shrink-0">
              <FileCode className="w-3 h-3" /> WRITE
            </span>
          )}

          <span className="text-slate-300 truncate">
            {isCommand && step.args?.command && (
              <code className="text-slate-200">$ {step.args.command}</code>
            )}
            {isFileWrite && step.args?.file_path && (
              <code className="text-emerald-300">/workspace/{step.args.file_path}</code>
            )}
          </span>
        </div>

        <span className="text-[11px] text-emerald-400 flex items-center gap-1 shrink-0 ml-2">
          <CheckCircle2 className="w-3 h-3" /> OK
        </span>
      </button>

      {isOpen && (
        <div className="p-3 bg-[#060a13] space-y-2.5">
          {isFileWrite && step.args?.content && (
            <div className="space-y-1">
              <div className="flex justify-between items-center text-[11px] text-slate-400">
                <span>Written Content</span>
                <button
                  type="button"
                  onClick={() => onSelectTab("files")}
                  className="text-emerald-400 hover:underline"
                >
                  View in Files
                </button>
              </div>
              <pre className="p-2.5 bg-[#090d18] rounded border border-[#162035] text-slate-300 overflow-x-auto max-h-48 text-[11px] leading-relaxed">
                {step.args.content}
              </pre>
            </div>
          )}

          {step.output && (
            <div className="space-y-1">
              <div className="flex justify-between items-center text-[11px] text-slate-400">
                <span>Output</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="text-slate-400 hover:text-slate-200 flex items-center gap-1"
                >
                  {copied ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <pre className="p-2.5 bg-[#090d18] rounded border border-[#162035] text-slate-300 overflow-x-auto max-h-56 text-[11px] leading-relaxed whitespace-pre-wrap">
                {step.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
