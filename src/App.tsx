import React, { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Header, type AppTab } from "./components/Header";
import { HomeDashboard } from "./components/HomeDashboard";
import { AgentChat } from "./components/AgentChat";
import { FileWorkspace } from "./components/FileWorkspace";
import { ProjectContextPanel } from "./components/ProjectContextPanel";
import { GitReviewPanel } from "./components/GitReviewPanel";
import { SchedulesPanel } from "./components/SchedulesPanel";
import { WorkflowsPanel } from "./components/WorkflowsPanel";
import { SetupStatusPanel } from "./components/SetupStatusPanel";
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
  AgentRequestError,
} from "./types";
import { apiFetch, getStoredApiToken, onUnauthorized, setStoredApiToken } from "./api";
import {
  StreamFallbackEligibleError,
  StreamProtocolError,
  StreamServerError,
  consumeChatStreamResponse,
  isStreamingEndpointMissingStatus,
  mapProgressStageToDiagnostic,
  parseHttpErrorResponse,
  type ChatCompletionPayload,
} from "./chat/streamClient";

export const INITIAL_APP_TAB: AppTab = "home";

export interface AppProps {
  initialTab?: AppTab;
  initialMessages?: ChatMessage[];
  initialRuntimeStatus?: RuntimeStatus | null;
  initialProjects?: ProjectSummary[];
  initialProjectId?: string;
  initialSessions?: SessionSummary[];
  initialActiveSessionId?: string | null;
  skipInitialFetch?: boolean;
  requestTimeoutMs?: number;
}

export default function App({
  initialTab = INITIAL_APP_TAB,
  initialMessages = [],
  initialRuntimeStatus = null,
  initialProjects = [],
  initialProjectId = "default",
  initialSessions = [],
  initialActiveSessionId = null,
  skipInitialFetch = false,
  requestTimeoutMs = 120000,
}: AppProps = {}) {
  const [activeTab, setActiveTab] = useState<AppTab>(initialTab);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const messagesRef = useRef<ChatMessage[]>(initialMessages);
  messagesRef.current = messages;
  const [draftPrompt, setDraftPrompt] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [progressEvents, setProgressEvents] = useState<AgentProgressEvent[]>([]);
  const [lastRequestError, setLastRequestError] = useState<AgentRequestError | null>(null);
  const inFlightSubmitRef = useRef<boolean>(false);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isResetModalOpen, setIsResetModalOpen] = useState<boolean>(false);
  const [isResetting, setIsResetting] = useState<boolean>(false);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(initialRuntimeStatus);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [tokenInput, setTokenInput] = useState<string>(() => getStoredApiToken());

  const [projects, setProjects] = useState<ProjectSummary[]>(initialProjects);
  const [activeProjectId, setActiveProjectId] = useState<string>(initialProjectId);
  const [sessions, setSessions] = useState<SessionSummary[]>(initialSessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialActiveSessionId);
  const initialProjectIdRef = useRef<string>(initialProjectId);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState<boolean>(false);
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [newProjectPath, setNewProjectPath] = useState<string>("");
  const [projectError, setProjectError] = useState<string>("");

  const [agentSettings, setAgentSettings] = useState<AgentSettings>({
    model: "gemini-3.6-flash",
    temperature: 0,
    systemInstruction: `You are NanoGem, an autonomous developer agent running inside a secure, isolated container sandbox.
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
        setLastRequestError(null);
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
        setMessages((previous) =>
          inFlightSubmitRef.current || previous.some((m) => m.isStreaming)
            ? previous
            : restored
        );
      }
    } catch (err) {
      console.error("Failed to resume session:", err);
    }
  }, []);

  const loadRuntimeStatus = useCallback(async (projectId: string = activeProjectId) => {
    try {
      const healthRes = await fetch("/api/health");
      if (healthRes.ok) {
        const health = await healthRes.json();
        if (health.authRequired && !getStoredApiToken()) {
          setIsAuthModalOpen(true);
        }
      }
      const res = await apiFetch(`/api/runtime/status?projectId=${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const data: RuntimeStatus = await res.json();
        setRuntimeStatus(data);
      }
    } catch (err) {
      console.error("Failed to load runtime status:", err);
    }
  }, [activeProjectId]);

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
        void loadRuntimeStatus(projectId);
      } catch (err) {
        console.error("Failed to select project:", err);
      }
    },
    [resumeSession, loadRuntimeStatus]
  );

  const loadProjects = useCallback(async () => {
    try {
      const res = await apiFetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        const list: ProjectSummary[] = data.projects || [];
        setProjects(list);
        const preferred = initialProjectIdRef.current;
        const targetId = list.some((p) => p.id === preferred)
          ? preferred
          : list[0]?.id || "default";
        await selectProject(targetId);
      }
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  }, [selectProject]);

  useEffect(() => {
    return () => {
      activeAbortControllerRef.current?.abort();
      activeAbortControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (skipInitialFetch) return;
    const unsubscribe = onUnauthorized(() => {
      setIsAuthModalOpen(true);
    });
    void loadRuntimeStatus(initialProjectIdRef.current);
    void loadProjects();
    return unsubscribe;
  }, [skipInitialFetch, loadRuntimeStatus, loadProjects]);

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
        setLastRequestError(null);
        setMessages([]);
      }
    } catch (err) {
      console.error("Failed to create new session:", err);
    }
  };

  const updateAssistantMessage = useCallback(
    (assistantMsgId: string, updater: (msg: ChatMessage) => ChatMessage) => {
      setMessages((previous) =>
        previous.map((msg) => (msg.id === assistantMsgId ? updater(msg) : msg))
      );
    },
    []
  );

  const handleSendMessage = async (
    text: string,
    options: { replaceFailedTurn?: { userMsgId: string; assistantMsgId: string } } = {}
  ): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed || inFlightSubmitRef.current || isExecuting) {
      return false;
    }

    inFlightSubmitRef.current = true;
    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const replaceTurn = options.replaceFailedTurn;
    const userMsgId =
      replaceTurn?.userMsgId || `user_${Math.random().toString(36).substring(2, 9)}`;
    const assistantMsgId =
      replaceTurn?.assistantMsgId || `asst_${Math.random().toString(36).substring(2, 9)}`;

    // Build conversation history from completed prior messages without relying on stale snapshots later
    const excludedIds = new Set(replaceTurn ? [replaceTurn.userMsgId, replaceTurn.assistantMsgId] : []);
    const history = messagesRef.current
      .filter((m) => !excludedIds.has(m.id) && !m.isStreaming && !m.errorMessage && m.content)
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

    setLastRequestError(null);
    setProgressEvents([]);
    setIsExecuting(true);

    if (replaceTurn) {
      setMessages((previous) =>
        previous.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: "",
                executionSteps: [],
                isStreaming: true,
                statusStage: "analyzing_request",
                statusLabel: "Analyzing request…",
                statusDetail: undefined,
                errorMessage: undefined,
              }
            : m
        )
      );
    } else {
      const newUserMsg: ChatMessage = {
        id: userMsgId,
        role: "user",
        content: trimmed,
        timestamp: timeStr,
      };
      const placeholderAssistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        timestamp: timeStr,
        executionSteps: [],
        isStreaming: true,
        statusStage: "analyzing_request",
        statusLabel: "Analyzing request…",
      };
      setMessages((previous) => [...previous, newUserMsg, placeholderAssistantMsg]);
    }

    const requestBody = JSON.stringify({
      message: trimmed,
      history,
      model: agentSettings.model,
      temperature: agentSettings.temperature,
      systemInstruction: agentSettings.systemInstruction,
      projectId: activeProjectId,
      sessionId: activeSessionId || undefined,
    });

    const executeJsonFallbackOnce = async (): Promise<ChatCompletionPayload> => {
      updateAssistantMessage(assistantMsgId, (msg) => ({
        ...msg,
        statusStage: "fallback",
        statusLabel: "Streaming unavailable — using standard JSON request…",
      }));

      const fallbackRes = await apiFetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        signal: controller.signal,
      });

      if (!fallbackRes.ok) {
        throw await parseHttpErrorResponse(fallbackRes);
      }
      return (await fallbackRes.json()) as ChatCompletionPayload;
    };

    try {
      let data: ChatCompletionPayload;

      try {
        const res = await apiFetch("/api/agent/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal: controller.signal,
        });

        if (!res.ok) {
          if (isStreamingEndpointMissingStatus(res.status)) {
            throw new StreamFallbackEligibleError(
              `Streaming endpoint unavailable (HTTP ${res.status}).`
            );
          }
          throw await parseHttpErrorResponse(res);
        }

        data = await consumeChatStreamResponse(res, {
          onProgress: (parsed) => {
            setProgressEvents((previous) => [...previous, parsed]);
            const diagnostic = mapProgressStageToDiagnostic(parsed.stage);
            updateAssistantMessage(assistantMsgId, (msg) => ({
              ...msg,
              statusStage: diagnostic.stage,
              statusLabel: diagnostic.label,
              statusDetail: parsed.detail,
            }));
          },
          onAssistantText: (payload) => {
            updateAssistantMessage(assistantMsgId, (msg) => {
              let nextContent = msg.content || "";
              if (typeof payload.delta === "string") {
                nextContent += payload.delta;
              } else if (typeof payload.text === "string" && payload.text) {
                nextContent =
                  nextContent && nextContent !== payload.text
                    ? `${nextContent}\n\n${payload.text}`
                    : payload.text;
              }
              return {
                ...msg,
                content: nextContent,
              };
            });
          },
          onToolCall: (payload) => {
            updateAssistantMessage(assistantMsgId, (msg) => ({
              ...msg,
              statusStage: "running_command",
              statusLabel: "Running sandbox command",
              executionSteps: [
                ...(msg.executionSteps || []),
                {
                  type: "tool_call",
                  toolName: payload.toolName,
                  args: payload.args,
                  output: "Running…",
                },
              ],
            }));
          },
          onToolResult: (payload) => {
            updateAssistantMessage(assistantMsgId, (msg) => {
              const steps = [...(msg.executionSteps || [])];
              let matchedIndex = -1;
              for (let i = steps.length - 1; i >= 0; i--) {
                if (
                  steps[i].type === "tool_call" &&
                  steps[i].toolName === payload.toolName &&
                  steps[i].output === "Running…"
                ) {
                  matchedIndex = i;
                  break;
                }
              }
              if (matchedIndex >= 0) {
                steps[matchedIndex] = { ...steps[matchedIndex], output: payload.output };
              } else {
                steps.push({
                  type: "tool_call",
                  toolName: payload.toolName,
                  output: payload.output,
                });
              }
              return {
                ...msg,
                executionSteps: steps,
              };
            });
          },
        });
      } catch (streamErr: any) {
        const isAbort = streamErr?.name === "AbortError" || timedOut || controller.signal.aborted;
        const canFallback =
          !isAbort &&
          (streamErr instanceof StreamFallbackEligibleError ||
            (streamErr instanceof TypeError && !(streamErr instanceof StreamProtocolError)));
        if (canFallback) {
          data = await executeJsonFallbackOnce();
        } else {
          throw streamErr;
        }
      }

      if (data.sessionId && data.sessionId !== activeSessionId) {
        setActiveSessionId(data.sessionId);
      }

      updateAssistantMessage(assistantMsgId, (msg) => ({
        ...msg,
        content: data.text || msg.content || "NanoGem completed execution.",
        executionSteps: Array.isArray(data.executionSteps)
          ? data.executionSteps
          : msg.executionSteps || [],
        isStreaming: false,
        statusStage: "completed",
        statusLabel: "Completed",
        statusDetail: undefined,
        errorMessage: undefined,
        configuredModel: data.configuredModel || agentSettings.model,
        modelUsed: data.modelUsed || agentSettings.model,
        fallbackUsed: Boolean(data.fallbackUsed),
      }));

      if (data.files) {
        setWorkspaceFiles(data.files);
      }
      return true;
    } catch (err: any) {
      const errorText = timedOut
        ? "Request timed out while waiting for NanoGem."
        : err instanceof Error || typeof err?.message === "string"
          ? err.message || "Agent execution failed."
          : "Agent execution failed.";

      const code = typeof err?.code === "string" ? err.code : undefined;
      const retryable =
        timedOut || err instanceof StreamProtocolError || Boolean(err?.retryable) || err?.name === "TypeError";
      const status = typeof err?.status === "number" ? err.status : undefined;

      updateAssistantMessage(assistantMsgId, (msg) => ({
        ...msg,
        isStreaming: false,
        statusStage: "failed",
        statusLabel: "Failed",
        errorMessage: errorText,
      }));

      setLastRequestError({
        error: errorText,
        code,
        retryable,
        status,
        failedPrompt: trimmed,
        failedUserMsgId: userMsgId,
        failedAssistantMsgId: assistantMsgId,
      });
      return false;
    } finally {
      clearTimeout(timeoutId);
      if (activeAbortControllerRef.current === controller) {
        activeAbortControllerRef.current = null;
      }
      inFlightSubmitRef.current = false;
      setIsExecuting(false);
    }
  };

  const handleRetryFailedPrompt = async (): Promise<boolean> => {
    if (!lastRequestError?.failedPrompt || inFlightSubmitRef.current || isExecuting) {
      return false;
    }
    const replaceFailedTurn =
      lastRequestError.failedUserMsgId && lastRequestError.failedAssistantMsgId
        ? {
            userMsgId: lastRequestError.failedUserMsgId,
            assistantMsgId: lastRequestError.failedAssistantMsgId,
          }
        : undefined;
    return handleSendMessage(lastRequestError.failedPrompt, { replaceFailedTurn });
  };

  const handleConfirmResetWorkspace = async () => {
    setIsResetting(true);
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
      setIsResetModalOpen(false);
    } catch (err) {
      console.error("Reset failed:", err);
    } finally {
      setIsResetting(false);
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

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const handleTryStarterPrompt = useCallback((prompt: string) => {
    setDraftPrompt(prompt);
    setActiveTab("chat");
  }, []);

  const handleConsumeDraftPrompt = useCallback(() => {
    setDraftPrompt(null);
  }, []);

  return (
    <div className="h-screen overflow-hidden bg-[#050811] text-slate-100 flex flex-col font-sans antialiased">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onRequestResetWorkspace={() => setIsResetModalOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        runtimeStatus={runtimeStatus}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={selectProject}
        onOpenNewProject={() => {
          setProjectError("");
          setIsNewProjectModalOpen(true);
        }}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={(sessionId) => resumeSession(sessionId, activeProjectId)}
        onStartNewSession={handleStartNewSession}
        isExecuting={isExecuting}
      />

      <main className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "home" && (
          <HomeDashboard
            runtimeStatus={runtimeStatus}
            activeProject={activeProject}
            activeProjectId={activeProjectId}
            activeSession={activeSession}
            activeSessionId={activeSessionId}
            messageCount={messages.length}
            onSelectTab={(tab) => setActiveTab(tab)}
            onTryPrompt={handleTryStarterPrompt}
          />
        )}

        {activeTab === "chat" && (
          <AgentChat
            messages={messages}
            onSendMessage={handleSendMessage}
            onSaveToMemory={handleSaveToProjectMemory}
            isExecuting={isExecuting}
            progressEvents={progressEvents}
            onSelectTab={(tab) => setActiveTab(tab)}
            projects={projects}
            activeProjectId={activeProjectId}
            onSelectProject={selectProject}
            onOpenNewProject={() => {
              setProjectError("");
              setIsNewProjectModalOpen(true);
            }}
            runtimeStatus={runtimeStatus}
            draftPrompt={draftPrompt}
            onConsumeDraftPrompt={handleConsumeDraftPrompt}
            lastError={lastRequestError}
            onRetry={handleRetryFailedPrompt}
            onDismissError={() => setLastRequestError(null)}
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
            projectName={activeProject?.name || activeProjectId}
          />
        )}

        {activeTab === "git" && (
          <GitReviewPanel
            projectId={activeProjectId}
            projectName={activeProject?.name || activeProjectId}
            onWorkspaceUpdated={() => loadWorkspaceFiles(activeProjectId)}
          />
        )}

        {activeTab === "schedules" && (
          <SchedulesPanel
            projectId={activeProjectId}
            projectName={activeProject?.name || activeProjectId}
          />
        )}

        {activeTab === "workflows" && (
          <WorkflowsPanel
            projectId={activeProjectId}
            projectName={activeProject?.name || activeProjectId}
            files={workspaceFiles}
            isExecuting={isExecuting}
            onWorkflowCompleted={(userPrompt, data) => {
              const now = new Date().toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              });
              setMessages((prev) => [
                ...prev,
                {
                  id: Math.random().toString(36).substring(2, 9),
                  role: "user",
                  content: userPrompt,
                  timestamp: now,
                },
                {
                  id: Math.random().toString(36).substring(2, 9),
                  role: "assistant",
                  content: data.text || "Workflow completed.",
                  timestamp: now,
                  executionSteps: data.executionSteps || [],
                  configuredModel: data.configuredModel || agentSettings.model,
                  modelUsed: data.modelUsed || agentSettings.model,
                  fallbackUsed: Boolean(data.fallbackUsed),
                },
              ]);
              if (data.files) setWorkspaceFiles(data.files);
              if (data.sessionId) setActiveSessionId(data.sessionId);
              setActiveTab("chat");
            }}
          />
        )}

        {activeTab === "setup" && (
          <SetupStatusPanel
            runtimeStatus={runtimeStatus}
            projectName={activeProject?.name || activeProjectId}
            onRefreshStatus={() => loadRuntimeStatus(activeProjectId)}
            onOpenNewProject={() => {
              setProjectError("");
              setIsNewProjectModalOpen(true);
            }}
            onSelectTab={(tab) => setActiveTab(tab)}
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

      {/* Reset Sandbox Confirmation Modal */}
      {isResetModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reset-sandbox-title"
            className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h2 id="reset-sandbox-title" className="text-sm font-bold text-slate-100">
                  Reset Sandbox Workspace
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Are you sure you want to reset{" "}
                  <strong className="text-slate-200">{activeProject?.name || activeProjectId}</strong>
                  &rsquo;s <code className="font-mono text-slate-200">/workspace/</code> directory?
                  All created and modified files will be cleared.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsResetModalOpen(false)}
                disabled={isResetting}
                className="px-3.5 py-1.5 bg-slate-800 text-slate-200 hover:bg-slate-700 rounded-lg text-xs font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmResetWorkspace}
                disabled={isResetting}
                className="px-4 py-1.5 bg-rose-500 hover:bg-rose-400 disabled:opacity-60 text-slate-950 font-semibold rounded-lg text-xs"
              >
                {isResetting ? "Resetting…" : "Reset Sandbox"}
              </button>
            </div>
          </div>
        </div>
      )}

      {isNewProjectModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <form
            onSubmit={handleCreateProject}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl"
          >
            <h2 className="text-sm font-bold text-slate-100">Create Isolated Project</h2>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">Project Name</label>
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="e.g., api-service"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Subdirectory inside approved root (optional)
              </label>
              <input
                type="text"
                value={newProjectPath}
                onChange={(e) => setNewProjectPath(e.target.value)}
                placeholder="e.g., api-service"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>
            {projectError && <p className="text-xs text-rose-400">{projectError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsNewProjectModalOpen(false)}
                className="px-3.5 py-1.5 bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-lg text-xs font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold rounded-lg text-xs"
              >
                Create Project
              </button>
            </div>
          </form>
        </div>
      )}

      {isAuthModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <form
            onSubmit={handleSaveApiToken}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl"
          >
            <h2 className="text-sm font-bold text-slate-100">API Authentication Required</h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Enter your <code className="font-mono text-emerald-400">NANOGEM_API_TOKEN</code> to authenticate requests to the NanoGem server.
            </p>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Paste NANOGEM_API_TOKEN..."
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsAuthModalOpen(false)}
                className="px-3.5 py-1.5 bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-lg text-xs font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold rounded-lg text-xs"
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
