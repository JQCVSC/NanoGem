import React, { useState, useEffect, useCallback } from "react";
import { FolderPlus, MessageSquarePlus, FolderGit2, History } from "lucide-react";
import { Header, type AppTab } from "./components/Header";
import { AgentChat } from "./components/AgentChat";
import { FileWorkspace } from "./components/FileWorkspace";
import { ProjectContextPanel } from "./components/ProjectContextPanel";
import { GitReviewPanel } from "./components/GitReviewPanel";
import { InteractiveTerminal } from "./components/InteractiveTerminal";
import { CodebaseExport } from "./components/CodebaseExport";
import { AgentConfigModal } from "./components/AgentConfigModal";
import {
  ChatMessage,
  WorkspaceFile,
  AgentSettings,
  RuntimeStatus,
  ProjectSummary,
  SessionSummary,
  AgentProgressEvent,
} from "./types";
import { apiFetch, getStoredApiToken, onUnauthorized, setStoredApiToken } from "./api";

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [progressEvents, setProgressEvents] = useState<AgentProgressEvent[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [tokenInput, setTokenInput] = useState<string>(() => getStoredApiToken());

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>("default");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState<boolean>(false);
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [newProjectPath, setNewProjectPath] = useState<string>("");
  const [projectError, setProjectError] = useState<string>("");

  const [agentSettings, setAgentSettings] = useState<AgentSettings>({
    model: "gemini-3.6-flash",
    temperature: 0,
    systemInstruction: `You are NanoGemini, an autonomous developer agent running inside a secure, isolated Docker sandbox.
You have the ability to execute bash terminal commands and write files directly to the file system.
Your working directory is restricted to \`/workspace/\`. 
If a user asks you to build an app, create the files, install the dependencies via bash, and verify it works.
Always think step-by-step. Use your tools immediately when needed without asking for permission.`,
    sandboxDir: "/workspace",
  });

  const loadWorkspaceFiles = useCallback(async (projectId: string = activeProjectId) => {
    try {
      const res = await apiFetch(`/api/workspace/files?projectId=${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const data = await res.json();
        setWorkspaceFiles(data.files || []);
      }
    } catch (err) {
      console.error("Failed to load workspace files:", err);
    }
  }, [activeProjectId]);

  const resumeSession = useCallback(async (sessionId: string, projectId: string) => {
    try {
      const res = await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}?projectId=${encodeURIComponent(projectId)}`
      );
      if (res.ok) {
        const data = await res.json();
        setActiveSessionId(sessionId);
        const restored: ChatMessage[] = (data.messages || []).map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: new Date(m.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          executionSteps: m.executionSteps || [],
        }));
        setMessages(restored);
      }
    } catch (err) {
      console.error("Failed to resume session:", err);
    }
  }, []);

  const selectProject = useCallback(
    async (projectId: string) => {
      try {
        const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/select`, {
          method: "POST",
        });
        if (!res.ok) return;
        const data = await res.json();
        setActiveProjectId(projectId);
        setWorkspaceFiles(data.files || []);
        const projectSessions: SessionSummary[] = data.sessions || [];
        setSessions(projectSessions);
        const targetSession = projectSessions[0] || data.defaultSession;
        if (targetSession) {
          await resumeSession(targetSession.id, projectId);
        } else {
          setActiveSessionId(null);
          setMessages([]);
        }
      } catch (err) {
        console.error("Failed to select project:", err);
      }
    },
    [resumeSession]
  );

  const loadProjects = useCallback(async () => {
    try {
      const res = await apiFetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        const list: ProjectSummary[] = data.projects || [];
        setProjects(list);
        const targetId = list.some((p) => p.id === activeProjectId)
          ? activeProjectId
          : list[0]?.id || "default";
        await selectProject(targetId);
      }
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  }, [activeProjectId, selectProject]);

  const loadRuntimeStatus = useCallback(async () => {
    try {
      const healthRes = await fetch("/api/health");
      if (healthRes.ok) {
        const health = await healthRes.json();
        if (health.authRequired && !getStoredApiToken()) {
          setIsAuthModalOpen(true);
        }
      }
      const res = await apiFetch("/api/runtime/status");
      if (res.ok) {
        const data: RuntimeStatus = await res.json();
        setRuntimeStatus(data);
      }
    } catch (err) {
      console.error("Failed to load runtime status:", err);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onUnauthorized(() => {
      setIsAuthModalOpen(true);
    });
    loadRuntimeStatus();
    loadProjects();
    return unsubscribe;
  }, [loadRuntimeStatus, loadProjects]);

  const handleSaveApiToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setStoredApiToken(tokenInput);
    setIsAuthModalOpen(false);
    await loadRuntimeStatus();
    await loadProjects();
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setProjectError("");
    if (!newProjectName.trim()) {
      setProjectError("Project name is required.");
      return;
    }
    try {
      const res = await apiFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProjectName.trim(),
          workspacePath: newProjectPath.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setProjectError(data.error || "Failed to create project.");
        return;
      }
      setNewProjectName("");
      setNewProjectPath("");
      setIsNewProjectModalOpen(false);
      const listRes = await apiFetch("/api/projects");
      if (listRes.ok) {
        const listData = await listRes.json();
        setProjects(listData.projects || []);
      }
      await selectProject(data.project.id);
    } catch (err: any) {
      setProjectError(err.message || "Failed to create project.");
    }
  };

  const handleStartNewSession = async () => {
    try {
      const res = await apiFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          title: `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
          model: agentSettings.model,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSessions((prev) => [data.session, ...prev]);
        setActiveSessionId(data.session.id);
        setMessages([]);
      }
    } catch (err) {
      console.error("Failed to create new session:", err);
    }
  };

  const handleSendMessage = async (text: string) => {
    const userMsgId = Math.random().toString(36).substring(2, 9);
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const newUserMsg: ChatMessage = {
      id: userMsgId,
      role: "user",
      content: text,
      timestamp: timeStr,
    };

    const previousMessages = [...messages];
    setMessages([...previousMessages, newUserMsg]);
    setProgressEvents([]);
    setIsExecuting(true);

    try {
      const history = previousMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await apiFetch("/api/agent/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history,
          model: agentSettings.model,
          temperature: agentSettings.temperature,
          systemInstruction: agentSettings.systemInstruction,
          projectId: activeProjectId,
          sessionId: activeSessionId || undefined,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to communicate with NanoGemini Agent");
      }

      const contentType = res.headers.get("content-type") || "";
      let data: any = null;

      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() || "";

          for (const block of blocks) {
            const lines = block.split(/\r?\n/);
            let eventName = "message";
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trim());
              }
            }
            if (dataLines.length === 0) continue;
            const parsed = JSON.parse(dataLines.join("\n"));
            if (eventName === "progress") {
              setProgressEvents((prev) => [...prev, parsed]);
            } else if (eventName === "result") {
              data = parsed;
            } else if (eventName === "error") {
              throw new Error(parsed.error || "Agent execution failed.");
            }
          }
        }
      } else {
        data = await res.json();
      }

      if (!data) {
        throw new Error("Stream ended before returning a final response.");
      }

      if (data.sessionId && data.sessionId !== activeSessionId) {
        setActiveSessionId(data.sessionId);
      }

      const agentMsgId = Math.random().toString(36).substring(2, 9);
      const newAgentMsg: ChatMessage = {
        id: agentMsgId,
        role: "assistant",
        content: data.text || "NanoGemini completed execution.",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        executionSteps: data.executionSteps || [],
      };

      setMessages((prev) => [...prev, newAgentMsg]);

      if (data.files) {
        setWorkspaceFiles(data.files);
      }
    } catch (err: any) {
      const errorMsgId = Math.random().toString(36).substring(2, 9);
      setMessages((prev) => [
        ...prev,
        {
          id: errorMsgId,
          role: "assistant",
          content: `⚠️ Error executing agent task: ${err.message}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleResetWorkspace = async () => {
    if (
      window.confirm(
        "Are you sure you want to reset this project's /workspace/ directory? All created files will be cleared."
      )
    ) {
      try {
        const res = await apiFetch("/api/workspace/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: activeProjectId }),
        });
        const data = await res.json();
        if (data.files) {
          setWorkspaceFiles(data.files);
        }
      } catch (err) {
        console.error("Reset failed:", err);
      }
    }
  };

  const handleSaveWorkspaceFile = async (path: string, content: string) => {
    try {
      await apiFetch("/api/workspace/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeProjectId, path, content }),
      });
      await loadWorkspaceFiles(activeProjectId);
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  };

  const handleDeleteWorkspaceFile = async (path: string) => {
    try {
      await apiFetch(
        `/api/workspace/file?projectId=${encodeURIComponent(activeProjectId)}&path=${encodeURIComponent(path)}`,
        {
          method: "DELETE",
        }
      );
      await loadWorkspaceFiles(activeProjectId);
    } catch (err) {
      console.error("Failed to delete file:", err);
    }
  };

  const handleSaveToProjectMemory = async (content: string) => {
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(activeProjectId)}/memory/append`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entry: content }),
        }
      );
      if (res.ok) {
        await loadWorkspaceFiles(activeProjectId);
      }
    } catch (err) {
      console.error("Failed to save to project memory:", err);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onResetWorkspace={handleResetWorkspace}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        runtimeStatus={runtimeStatus}
        isExecuting={isExecuting}
      />

      {/* Project & Session Switcher Bar */}
      <div className="bg-slate-900/70 border-b border-slate-800 px-4 py-2 text-xs font-mono">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-slate-400">
              <FolderGit2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Project:</span>
              <select
                aria-label="Active Project"
                value={activeProjectId}
                onChange={(e) => selectProject(e.target.value)}
                disabled={isExecuting}
                className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 focus:outline-none focus:border-emerald-500"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                setProjectError("");
                setIsNewProjectModalOpen(true);
              }}
              disabled={isExecuting}
              className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 flex items-center gap-1"
            >
              <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
              <span>New Project</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-slate-400">
              <History className="w-3.5 h-3.5 text-emerald-400" />
              <span>Session:</span>
              <select
                aria-label="Active Session"
                value={activeSessionId || ""}
                onChange={(e) => resumeSession(e.target.value, activeProjectId)}
                disabled={isExecuting || sessions.length === 0}
                className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 focus:outline-none focus:border-emerald-500"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleStartNewSession}
              disabled={isExecuting}
              className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 flex items-center gap-1"
            >
              <MessageSquarePlus className="w-3.5 h-3.5 text-emerald-400" />
              <span>New Session</span>
            </button>
          </div>
        </div>
      </div>

      <main className="flex-1 overflow-hidden">
        {activeTab === "chat" && (
          <AgentChat
            messages={messages}
            onSendMessage={handleSendMessage}
            onSaveToMemory={handleSaveToProjectMemory}
            isExecuting={isExecuting}
            progressEvents={progressEvents}
            onSelectTab={(tab) => setActiveTab(tab)}
          />
        )}

        {activeTab === "files" && (
          <FileWorkspace
            projectId={activeProjectId}
            files={workspaceFiles}
            onRefreshFiles={() => loadWorkspaceFiles(activeProjectId)}
            onSaveFile={handleSaveWorkspaceFile}
            onDeleteFile={handleDeleteWorkspaceFile}
          />
        )}

        {activeTab === "context" && (
          <ProjectContextPanel
            projectId={activeProjectId}
            projectName={
              projects.find((p) => p.id === activeProjectId)?.name || activeProjectId
            }
          />
        )}

        {activeTab === "git" && (
          <GitReviewPanel
            projectId={activeProjectId}
            projectName={
              projects.find((p) => p.id === activeProjectId)?.name || activeProjectId
            }
            onWorkspaceUpdated={() => loadWorkspaceFiles(activeProjectId)}
          />
        )}

        {activeTab === "terminal" && (
          <InteractiveTerminal projectId={activeProjectId} sessionId={activeSessionId} />
        )}

        {activeTab === "export" && <CodebaseExport />}
      </main>

      <AgentConfigModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={agentSettings}
        onSaveSettings={(newSettings) => setAgentSettings(newSettings)}
      />

      {isNewProjectModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 font-mono">
          <form
            onSubmit={handleCreateProject}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl"
          >
            <h2 className="text-sm font-bold text-slate-100">Create Isolated Project</h2>
            <div className="space-y-2">
              <label className="block text-xs text-slate-300">Project Name</label>
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="e.g., api-service"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-xs text-slate-300">
                Subdirectory inside approved root (optional)
              </label>
              <input
                type="text"
                value={newProjectPath}
                onChange={(e) => setNewProjectPath(e.target.value)}
                placeholder="e.g., api-service"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>
            {projectError && <p className="text-xs text-rose-400">{projectError}</p>}
            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => setIsNewProjectModalOpen(false)}
                className="px-3 py-1.5 bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-lg text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs"
              >
                Create Project
              </button>
            </div>
          </form>
        </div>
      )}

      {isAuthModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 font-mono">
          <form
            onSubmit={handleSaveApiToken}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl"
          >
            <h2 className="text-sm font-bold text-slate-100">API Authentication Required</h2>
            <p className="text-xs text-slate-400">
              Enter your <code className="text-emerald-400">NANOGEM_API_TOKEN</code> to authenticate requests to the NanoGem server.
            </p>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Paste NANOGEM_API_TOKEN..."
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
            />
            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => setIsAuthModalOpen(false)}
                className="px-3 py-1.5 bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-lg text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs"
              >
                Save Token
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
