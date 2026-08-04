import React, { useState, useEffect } from "react";
import { Header } from "./components/Header";
import { AgentChat } from "./components/AgentChat";
import { FileWorkspace } from "./components/FileWorkspace";
import { InteractiveTerminal } from "./components/InteractiveTerminal";
import { CodebaseExport } from "./components/CodebaseExport";
import { AgentConfigModal } from "./components/AgentConfigModal";
import { ChatMessage, WorkspaceFile, AgentSettings } from "./types";

export default function App() {
  const [activeTab, setActiveTab] = useState<"chat" | "files" | "terminal" | "export">("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

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

  // Load initial workspace file tree
  const loadWorkspaceFiles = async () => {
    try {
      const res = await fetch("/api/workspace/files");
      if (res.ok) {
        const data = await res.json();
        setWorkspaceFiles(data.files || []);
      }
    } catch (err) {
      console.error("Failed to load workspace files:", err);
    }
  };

  useEffect(() => {
    loadWorkspaceFiles();
  }, []);

  // Handle Agent Chat Message Submission
  const handleSendMessage = async (text: string) => {
    const userMsgId = Math.random().toString(36).substring(2, 9);
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const newUserMsg: ChatMessage = {
      id: userMsgId,
      role: "user",
      content: text,
      timestamp: timeStr,
    };

    const updatedMessages = [...messages, newUserMsg];
    setMessages(updatedMessages);
    setIsExecuting(true);

    try {
      // Build previous turn context for backend
      const history = updatedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history,
          model: agentSettings.model,
          systemInstruction: agentSettings.systemInstruction,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to communicate with NanoGemini Agent");
      }

      const agentMsgId = Math.random().toString(36).substring(2, 9);
      const newAgentMsg: ChatMessage = {
        id: agentMsgId,
        role: "assistant",
        content: data.text || "NanoGemini completed execution.",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
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
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsExecuting(false);
    }
  };

  // Reset Sandbox Workspace
  const handleResetWorkspace = async () => {
    if (window.confirm("Are you sure you want to reset the /workspace/ directory to default state? All created files will be cleared.")) {
      try {
        const res = await fetch("/api/workspace/reset", { method: "POST" });
        const data = await res.json();
        if (data.files) {
          setWorkspaceFiles(data.files);
        }
        setMessages([]);
      } catch (err) {
        console.error("Reset failed:", err);
      }
    }
  };

  // Save File directly in Workspace Editor
  const handleSaveWorkspaceFile = async (path: string, content: string) => {
    try {
      await fetch("/api/workspace/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content }),
      });
      await loadWorkspaceFiles();
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  };

  // Delete File in Workspace Editor
  const handleDeleteWorkspaceFile = async (path: string) => {
    try {
      await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      await loadWorkspaceFiles();
    } catch (err) {
      console.error("Failed to delete file:", err);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onResetWorkspace={handleResetWorkspace}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isExecuting={isExecuting}
      />

      <main className="flex-1 overflow-hidden">
        {activeTab === "chat" && (
          <AgentChat
            messages={messages}
            onSendMessage={handleSendMessage}
            isExecuting={isExecuting}
            onSelectTab={(tab) => setActiveTab(tab)}
          />
        )}

        {activeTab === "files" && (
          <FileWorkspace
            files={workspaceFiles}
            onRefreshFiles={loadWorkspaceFiles}
            onSaveFile={handleSaveWorkspaceFile}
            onDeleteFile={handleDeleteWorkspaceFile}
          />
        )}

        {activeTab === "terminal" && <InteractiveTerminal />}

        {activeTab === "export" && <CodebaseExport />}
      </main>

      <AgentConfigModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={agentSettings}
        onSaveSettings={(newSettings) => setAgentSettings(newSettings)}
      />
    </div>
  );
}
