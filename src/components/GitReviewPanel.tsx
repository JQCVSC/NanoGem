import React, { useState, useEffect, useCallback } from "react";
import {
  GitBranch,
  GitCommit,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  CheckCircle2,
  FileDiff,
  AlertTriangle,
} from "lucide-react";
import { apiFetch } from "../api";
import { GitDiffInfo, GitStatusInfo } from "../types";

interface GitReviewPanelProps {
  projectId: string;
  projectName: string;
  onWorkspaceUpdated?: () => void;
}

export const GitReviewPanel: React.FC<GitReviewPanelProps> = ({
  projectId,
  projectName,
  onWorkspaceUpdated,
}) => {
  const [status, setStatus] = useState<GitStatusInfo | null>(null);
  const [diffInfo, setDiffInfo] = useState<GitDiffInfo | null>(null);
  const [branchInput, setBranchInput] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [confirmModal, setConfirmModal] = useState<"revert" | "commit" | null>(null);

  const loadGitData = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg("");
    try {
      const [stRes, dfRes] = await Promise.all([
        apiFetch(`/api/projects/${encodeURIComponent(projectId)}/git/status`),
        apiFetch(`/api/projects/${encodeURIComponent(projectId)}/git/diff`),
      ]);
      if (stRes.ok) {
        setStatus(await stRes.json());
      }
      if (dfRes.ok) {
        setDiffInfo(await dfRes.json());
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to load Git status.");
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadGitData();
  }, [loadGitData]);

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setFeedback("");
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/git/branch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branchName: branchInput }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create branch.");
      setBranchInput("");
      setFeedback(`Switched to new branch "${data.branch}".`);
      await loadGitData();
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handleConfirmedRevert = async () => {
    setErrorMsg("");
    setFeedback("");
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/git/revert`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to revert workspace changes.");
      setConfirmModal(null);
      setFeedback("Reverted workspace changes back to HEAD.");
      await loadGitData();
      onWorkspaceUpdated?.();
    } catch (err: any) {
      setErrorMsg(err.message);
      setConfirmModal(null);
    }
  };

  const handleConfirmedCommit = async () => {
    setErrorMsg("");
    setFeedback("");
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/git/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: commitMessage, confirm: true }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to commit changes.");
      setConfirmModal(null);
      setCommitMessage("");
      setFeedback(`Committed changes (${data.commitHash}): ${data.message}`);
      await loadGitData();
    } catch (err: any) {
      setErrorMsg(err.message);
      setConfirmModal(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#060914] text-slate-100 font-mono p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Header Bar */}
        <div className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <FileDiff className="w-5 h-5 text-sky-400" />
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                Git Review &amp; Revert &mdash; {projectName}
              </h2>
              <p className="text-[11px] text-slate-400">
                Remote push is disabled by design; host SSH keys and Git credentials are never exposed inside the sandbox.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={loadGitData}
            disabled={isLoading}
            className="px-3 py-1.5 bg-[#152042] hover:bg-[#1d2b57] text-slate-200 rounded-lg text-xs border border-[#24325c] flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            <span>Refresh Diff</span>
          </button>
        </div>

        {feedback && (
          <div className="bg-emerald-950/40 border border-emerald-500/40 text-emerald-300 text-xs rounded-lg px-4 py-2 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            <span>{feedback}</span>
          </div>
        )}

        {errorMsg && (
          <div className="bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs rounded-lg px-4 py-2 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" />
            <span>{errorMsg}</span>
          </div>
        )}

        {status && !status.isGitRepo ? (
          <div className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-6 text-xs text-slate-300 space-y-2">
            <p className="font-bold text-slate-100">Not a Git Repository</p>
            <p className="text-slate-400">
              This project workspace does not contain an isolated <code>.git</code> directory.
              NanoGem continues to support normal file editing, chat, and sandboxed terminal execution
              without touching any parent Git repository.
            </p>
          </div>
        ) : (
          status && (
            <>
              {/* Status & Actions */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Current Branch</span>
                    <span className="px-2 py-0.5 bg-sky-500/15 border border-sky-400/35 text-sky-300 rounded-md flex items-center gap-1">
                      <GitBranch className="w-3 h-3" />
                      {status.branch || "HEAD"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">HEAD</span>
                    <code className="text-slate-200">{status.headCommit || "(unborn)"}</code>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Workspace State</span>
                    {status.clean ? (
                      <span className="text-emerald-400 font-bold">Clean</span>
                    ) : (
                      <span className="text-amber-400 font-bold">
                        {status.entries.length} uncommitted change(s)
                      </span>
                    )}
                  </div>
                </div>

                {/* Create Branch */}
                <form
                  onSubmit={handleCreateBranch}
                  className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 space-y-2.5 text-xs"
                >
                  <label className="block font-bold text-slate-200">Create Branch</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={branchInput}
                      onChange={(e) => setBranchInput(e.target.value)}
                      placeholder="feature/my-change"
                      className="flex-1 bg-[#080c1a] border border-[#1b2544] rounded-lg px-2.5 py-1.5 text-slate-100 focus:outline-none focus:border-sky-400"
                    />
                    <button
                      type="submit"
                      disabled={!branchInput.trim()}
                      className="px-3 py-1.5 bg-[#152042] hover:bg-[#1d2b57] disabled:opacity-50 text-slate-100 rounded-lg border border-[#24325c] font-bold"
                    >
                      Branch
                    </button>
                  </div>
                </form>

                {/* Commit & Reset/Revert */}
                <div className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 space-y-2.5 text-xs">
                  <label className="block font-bold text-slate-200">
                    Commit or Reset/Revert
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      placeholder="Commit message..."
                      className="flex-1 bg-[#080c1a] border border-[#1b2544] rounded-lg px-2.5 py-1.5 text-slate-100 focus:outline-none focus:border-sky-400"
                    />
                    <button
                      type="button"
                      disabled={status.clean || !commitMessage.trim()}
                      onClick={() => setConfirmModal("commit")}
                      className="px-3 py-1.5 bg-sky-400 hover:bg-sky-300 disabled:bg-[#141d38] disabled:text-slate-500 text-[#060914] font-bold rounded-lg flex items-center gap-1"
                    >
                      <GitCommit className="w-3.5 h-3.5" />
                      <span>Commit</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={status.clean}
                    onClick={() => setConfirmModal("revert")}
                    className="w-full py-1.5 bg-rose-950/60 hover:bg-rose-900/70 disabled:opacity-40 text-rose-300 border border-rose-500/40 rounded-lg flex items-center justify-center gap-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Reset / Revert Workspace Changes</span>
                  </button>
                </div>
              </div>

              {/* Changed Files List */}
              {status.entries.length > 0 && (
                <div className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 space-y-2 text-xs">
                  <h3 className="font-bold text-slate-200">Changed Files</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {status.entries.map((entry) => (
                      <div
                        key={entry.path}
                        className="flex items-center justify-between bg-[#080c1a] border border-[#1b2544] rounded px-2.5 py-1.5"
                      >
                        <code className="text-slate-200 truncate">{entry.path}</code>
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-[#152042] text-amber-300">
                          {entry.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Diff Viewer */}
              <div className="bg-[#0b1022] border border-[#1b2544] rounded-xl overflow-hidden text-xs">
                <div className="px-4 py-2.5 border-b border-[#1b2544] flex items-center justify-between">
                  <span className="font-bold text-slate-200">Workspace Diff</span>
                  {diffInfo?.truncated && (
                    <span className="text-amber-400">Diff truncated at 256 KiB</span>
                  )}
                </div>
                <pre className="p-4 bg-[#080c1a] text-slate-200 overflow-x-auto max-h-[420px] whitespace-pre-wrap leading-relaxed">
                  {diffInfo?.diff
                    ? diffInfo.diff
                    : diffInfo?.untrackedFiles?.length
                      ? `Untracked files:\n${diffInfo.untrackedFiles.map((f) => `+ ${f}`).join("\n")}`
                      : "No uncommitted changes."}
                </pre>
              </div>
            </>
          )
        )}
      </div>

      {/* Explicit Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 bg-[#060914]/85 backdrop-blur-sm flex items-center justify-center z-50 p-4 font-mono">
          <div className="bg-[#0b1022] border border-[#222e52] rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl">
            <div className="flex items-center gap-2 text-amber-400">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="text-sm font-bold text-slate-100">
                {confirmModal === "revert"
                  ? "Confirm Workspace Revert"
                  : "Confirm Local Git Commit"}
              </h3>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              {confirmModal === "revert"
                ? "This will permanently discard all uncommitted tracked edits and delete untracked files in this project workspace."
                : `Commit all current workspace changes locally with message: "${commitMessage}"? (Remote push remains disabled.)`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmModal(null)}
                className="px-3 py-1.5 bg-[#152042] text-slate-300 hover:bg-[#1d2b57] rounded-lg text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={
                  confirmModal === "revert" ? handleConfirmedRevert : handleConfirmedCommit
                }
                className={`px-4 py-1.5 font-bold rounded-lg text-xs ${
                  confirmModal === "revert"
                    ? "bg-rose-500 hover:bg-rose-400 text-[#060914]"
                    : "bg-sky-400 hover:bg-sky-300 text-[#060914]"
                }`}
              >
                {confirmModal === "revert" ? "Confirm Revert" : "Confirm Commit"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
