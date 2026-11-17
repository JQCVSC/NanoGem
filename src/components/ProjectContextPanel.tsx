import React, { useState, useEffect, useCallback } from "react";
import { BookOpen, BrainCircuit, Save, AlertTriangle, RotateCcw, Check } from "lucide-react";
import { apiFetch } from "../api";

interface ProjectContextPanelProps {
  projectId: string;
  projectName: string;
}

export const ProjectContextPanel: React.FC<ProjectContextPanelProps> = ({
  projectId,
  projectName,
}) => {
  const [geminiMd, setGeminiMd] = useState("");
  const [memoryMd, setMemoryMd] = useState("");
  const [defaultGeminiTemplate, setDefaultGeminiTemplate] = useState("");
  const [defaultMemoryTemplate, setDefaultMemoryTemplate] = useState("");
  const [maxBytes, setMaxBytes] = useState(16384);
  const [geminiTruncated, setGeminiTruncated] = useState(false);
  const [memoryTruncated, setMemoryTruncated] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const loadContext = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage("");
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/context`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to load project instructions and memory.");
      }
      const data = await res.json();
      setGeminiMd(data.geminiMd || "");
      setMemoryMd(data.memoryMd || "");
      setDefaultGeminiTemplate(data.defaultGeminiTemplate || "");
      setDefaultMemoryTemplate(data.defaultMemoryTemplate || "");
      setMaxBytes(data.maxBytes || 16384);
      setGeminiTruncated(Boolean(data.geminiTruncated));
      setMemoryTruncated(Boolean(data.memoryTruncated));
    } catch (err: any) {
      setErrorMessage(err.message || "Error loading context");
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  const handleSave = async (kind: "GEMINI.md" | "MEMORY.md", content: string) => {
    setErrorMessage("");
    setStatusMessage("");
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/context`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, content }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Failed to save ${kind}`);
      }
      setGeminiMd(data.geminiMd || "");
      setMemoryMd(data.memoryMd || "");
      const redactedNote =
        data.saved?.redactedCount > 0
          ? ` (${data.saved.redactedCount} secret pattern(s) redacted)`
          : "";
      setStatusMessage(`Saved ${kind} (${data.saved?.bytes ?? 0} bytes)${redactedNote}.`);
    } catch (err: any) {
      setErrorMessage(err.message || `Failed to save ${kind}`);
    }
  };

  const geminiBytes = new TextEncoder().encode(geminiMd).length;
  const memoryBytes = new TextEncoder().encode(memoryMd).length;

  return (
    <div className="h-[calc(100vh-110px)] overflow-y-auto bg-slate-950 text-slate-100 font-mono p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Prompt Injection & Gemini Data-Handling Warning */}
        <div className="bg-amber-950/30 border border-amber-500/40 rounded-xl p-4 flex items-start gap-3 text-xs">
          <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold text-amber-300">
              Security & Data-Handling Notice for &ldquo;{projectName}&rdquo;
            </p>
            <p className="text-slate-300 leading-relaxed">
              Repository files, <code>GEMINI.md</code>, and <code>MEMORY.md</code> are{" "}
              <strong className="text-amber-200">untrusted content</strong> if sourced from external
              repos—review edits carefully to guard against prompt injection. Never store API keys,
              bot tokens, or <code>.env</code> secrets here. Note that while command execution stays
              local inside the sandbox, prompts along with loaded instructions and project memory are
              sent to the Google Gemini API for inference.
            </p>
          </div>
        </div>

        {statusMessage && (
          <div className="bg-emerald-950/40 border border-emerald-500/40 text-emerald-300 text-xs rounded-lg px-4 py-2 flex items-center gap-2">
            <Check className="w-4 h-4" />
            <span>{statusMessage}</span>
          </div>
        )}

        {errorMessage && (
          <div className="bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs rounded-lg px-4 py-2">
            {errorMessage}
          </div>
        )}

        {isLoading ? (
          <div className="text-xs text-slate-400">Loading project instructions and memory...</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* GEMINI.md Editor */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-emerald-400" />
                  <div>
                    <h3 className="text-xs font-bold text-slate-100">GEMINI.md</h3>
                    <p className="text-[11px] text-slate-400">
                      Durable project instructions injected into the system prompt
                    </p>
                  </div>
                </div>
                <span className="text-[11px] text-slate-400">
                  {geminiBytes}/{maxBytes} bytes
                </span>
              </div>

              {geminiTruncated && (
                <div className="px-4 py-1.5 bg-amber-950/40 text-amber-300 text-[11px] border-b border-amber-500/30">
                  Truncated to {maxBytes} bytes when loaded.
                </div>
              )}

              <textarea
                rows={16}
                value={geminiMd}
                onChange={(e) => setGeminiMd(e.target.value)}
                placeholder="Write project-specific Gemini instructions here..."
                className="w-full flex-1 p-4 bg-slate-950 text-slate-200 text-xs leading-relaxed focus:outline-none resize-none"
              />

              <div className="px-4 py-2.5 border-t border-slate-800 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setGeminiMd(defaultGeminiTemplate)}
                  className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Load Template</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSave("GEMINI.md", geminiMd)}
                  className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save GEMINI.md</span>
                </button>
              </div>
            </div>

            {/* MEMORY.md Editor */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-emerald-400" />
                  <div>
                    <h3 className="text-xs font-bold text-slate-100">MEMORY.md</h3>
                    <p className="text-[11px] text-slate-400">
                      Curated project memory (only updated by explicit user save)
                    </p>
                  </div>
                </div>
                <span className="text-[11px] text-slate-400">
                  {memoryBytes}/{maxBytes} bytes
                </span>
              </div>

              {memoryTruncated && (
                <div className="px-4 py-1.5 bg-amber-950/40 text-amber-300 text-[11px] border-b border-amber-500/30">
                  Truncated to {maxBytes} bytes when loaded.
                </div>
              )}

              <textarea
                rows={16}
                value={memoryMd}
                onChange={(e) => setMemoryMd(e.target.value)}
                placeholder="Curate durable architecture notes, conventions, and decisions here..."
                className="w-full flex-1 p-4 bg-slate-950 text-slate-200 text-xs leading-relaxed focus:outline-none resize-none"
              />

              <div className="px-4 py-2.5 border-t border-slate-800 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setMemoryMd(defaultMemoryTemplate)}
                  className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Load Template</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSave("MEMORY.md", memoryMd)}
                  className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save MEMORY.md</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
