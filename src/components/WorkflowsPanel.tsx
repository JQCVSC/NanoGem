import React, { useState, useEffect } from "react";
import { FileSpreadsheet, AlertTriangle, Play, CheckSquare, Square } from "lucide-react";
import { apiFetch } from "../api";
import { WorkflowTemplateInfo, WorkspaceFile } from "../types";

interface WorkflowsPanelProps {
  projectId: string;
  projectName: string;
  files: WorkspaceFile[];
  isExecuting: boolean;
  onWorkflowCompleted: (userPrompt: string, responseData: any) => void;
}

function flattenFiles(nodes: WorkspaceFile[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      out.push(...flattenFiles(node.children));
    } else if (!node.isDirectory) {
      out.push(node.path);
    }
  }
  return out;
}

export const WorkflowsPanel: React.FC<WorkflowsPanelProps> = ({
  projectId,
  projectName,
  files,
  isExecuting,
  onWorkflowCompleted,
}) => {
  const [templates, setTemplates] = useState<WorkflowTemplateInfo[]>([]);
  const [notice, setNotice] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("technical_research");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [goal, setGoal] = useState("");
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    apiFetch("/api/workflows/templates")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setTemplates(data.templates || []);
          setNotice(data.dataHandlingNotice || "");
        }
      })
      .catch(() => {});
  }, []);

  const activeTemplate = templates.find((t) => t.id === selectedTemplateId) || templates[0];
  const allFilePaths = flattenFiles(files);

  const toggleFile = (filePath: string) => {
    setSelectedFiles((prev) =>
      prev.includes(filePath) ? prev.filter((p) => p !== filePath) : [...prev, filePath]
    );
  };

  const handleRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTemplate || !confirmUpload || isRunning || isExecuting) return;
    setErrorMsg("");
    setIsRunning(true);
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/workflows/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateId: activeTemplate.id,
            goal: goal.trim() || activeTemplate.defaultGoal,
            selectedFiles,
            confirmSendToGemini: confirmUpload,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Workflow execution failed.");
      onWorkflowCompleted(
        `[Workflow: ${activeTemplate.title}] ${goal.trim() || activeTemplate.defaultGoal}`,
        data
      );
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#060914] text-slate-100 font-mono p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Warning Banner */}
        <div className="bg-amber-950/30 border border-amber-500/40 rounded-xl p-4 flex items-start gap-3 text-xs">
          <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold text-amber-300">
              Project Workflow Templates &amp; Data-Handling Warning ({projectName})
            </p>
            <p className="text-slate-300 leading-relaxed">
              {notice ||
                "Local execution and artifacts are controlled by you inside your sandbox, while Gemini API requests and selected file excerpts are processed by Google."}
            </p>
          </div>
        </div>

        {errorMsg && (
          <div className="bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs rounded-lg px-4 py-2">
            {errorMsg}
          </div>
        )}

        {/* Template Selector */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setSelectedTemplateId(t.id);
                setGoal(t.defaultGoal);
              }}
              className={`text-left p-4 rounded-xl border transition-colors space-y-1.5 ${
                selectedTemplateId === t.id
                  ? "bg-sky-950/30 border-sky-400/60"
                  : "bg-[#0b1022] border-[#1b2544] hover:border-[#2a3966]"
              }`}
            >
              <div className="flex items-center gap-2 font-bold text-slate-100">
                <FileSpreadsheet className="w-4 h-4 text-violet-400" />
                <span>{t.title}</span>
              </div>
              <p className="text-slate-400">{t.description}</p>
              <p className="text-[11px] text-sky-300">Output: {t.outputFormat}</p>
              <p className="text-[10px] text-slate-500">
                Allowed: {t.allowedExtensions.join(", ")} (max {Math.round(t.maxFileBytes / 1024)} KiB/file)
              </p>
            </button>
          ))}
        </div>

        {/* File Selection & Confirmation */}
        <form
          onSubmit={handleRun}
          className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 space-y-4 text-xs"
        >
          <div className="space-y-1.5">
            <label className="font-bold text-slate-200 block">Workflow Goal</label>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={activeTemplate?.defaultGoal || "Describe what you want to analyze or generate..."}
              className="w-full bg-[#080c1a] border border-[#1b2544] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-400"
            />
          </div>

          <div className="space-y-1.5">
            <label className="font-bold text-slate-200 block">
              Select Workspace Files to Include (sensitive files like <code>.env</code> are blocked)
            </label>
            <div className="max-h-40 overflow-y-auto bg-[#080c1a] border border-[#1b2544] rounded-lg p-2 space-y-1">
              {allFilePaths.length === 0 ? (
                <p className="text-slate-500 p-2">No files in this project workspace yet.</p>
              ) : (
                allFilePaths.map((fp) => {
                  const checked = selectedFiles.includes(fp);
                  return (
                    <button
                      key={fp}
                      type="button"
                      onClick={() => toggleFile(fp)}
                      className="w-full text-left px-2 py-1 rounded hover:bg-[#152042] flex items-center gap-2 text-slate-300"
                    >
                      {checked ? (
                        <CheckSquare className="w-3.5 h-3.5 text-sky-400" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-slate-600" />
                      )}
                      <span>{fp}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <label className="flex items-start gap-2 text-amber-200 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmUpload}
              onChange={(e) => setConfirmUpload(e.target.checked)}
              className="mt-0.5 accent-sky-400"
            />
            <span>
              I confirm sending my goal and the selected workspace file contents to the Google Gemini API.
            </span>
          </label>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!confirmUpload || isRunning || isExecuting}
              className="px-4 py-2 bg-sky-400 hover:bg-sky-300 disabled:bg-[#141d38] disabled:text-slate-500 text-[#060914] font-bold rounded-lg flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{isRunning ? "Running Workflow..." : "Run Workflow"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
