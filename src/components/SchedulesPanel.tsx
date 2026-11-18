import React, { useState, useEffect, useCallback } from "react";
import { Clock, Play, Pause, Trash2, Plus, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import { apiFetch } from "../api";
import { ScheduledTaskInfo, ScheduledTaskRunInfo } from "../types";

interface SchedulesPanelProps {
  projectId: string;
  projectName: string;
}

export const SchedulesPanel: React.FC<SchedulesPanelProps> = ({
  projectId,
  projectName,
}) => {
  const [enabledByEnv, setEnabledByEnv] = useState(false);
  const [tasks, setTasks] = useState<ScheduledTaskInfo[]>([]);
  const [runs, setRuns] = useState<ScheduledTaskRunInfo[]>([]);
  const [name, setName] = useState("");
  const [taskKind, setTaskKind] = useState<"test_run" | "repo_status" | "dependency_report">(
    "test_run"
  );
  const [scheduleExpr, setScheduleExpr] = useState("15m");
  const [notifyChatId, setNotifyChatId] = useState("");
  const [enableImmediately, setEnableImmediately] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const loadSchedules = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch(
        `/api/schedules?projectId=${encodeURIComponent(projectId)}`
      );
      if (res.ok) {
        const data = await res.json();
        setEnabledByEnv(Boolean(data.enabledByEnv));
        setTasks(data.schedules || []);
        setRuns(data.runs || []);
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to load schedules.");
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setStatusMsg("");
    try {
      const res = await apiFetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          name: name.trim(),
          taskKind,
          scheduleExpr: scheduleExpr.trim(),
          enabled: enableImmediately,
          notifyTelegramChatId: notifyChatId.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create schedule.");
      setName("");
      setNotifyChatId("");
      setStatusMsg(`Created scheduled task "${data.task.name}".`);
      await loadSchedules();
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handleAction = async (
    taskId: string,
    action: "pause" | "resume" | "run-now" | "delete"
  ) => {
    setErrorMsg("");
    setStatusMsg("");
    try {
      const res =
        action === "delete"
          ? await apiFetch(`/api/schedules/${encodeURIComponent(taskId)}`, {
              method: "DELETE",
            })
          : await apiFetch(
              `/api/schedules/${encodeURIComponent(taskId)}/${action}`,
              { method: "POST" }
            );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action} task.`);
      setStatusMsg(`Task ${action} completed.`);
      await loadSchedules();
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#060914] text-slate-100 font-mono p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Clock className="w-5 h-5 text-sky-400" />
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                Scheduled Tasks &mdash; {projectName}
              </h2>
              <p className="text-[11px] text-slate-400">
                Background runner:{" "}
                <span className={enabledByEnv ? "text-emerald-400" : "text-amber-400"}>
                  {enabledByEnv
                    ? "Enabled (NANOGEM_SCHEDULES_ENABLED=true)"
                    : "Disabled by default (set NANOGEM_SCHEDULES_ENABLED=true to auto-run)"}
                </span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={loadSchedules}
            disabled={isLoading}
            className="px-3 py-1.5 bg-[#152042] hover:bg-[#1d2b57] text-slate-200 rounded-lg text-xs border border-[#24325c] flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>

        {statusMsg && (
          <div className="bg-emerald-950/40 border border-emerald-500/40 text-emerald-300 text-xs rounded-lg px-4 py-2 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            <span>{statusMsg}</span>
          </div>
        )}

        {errorMsg && (
          <div className="bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs rounded-lg px-4 py-2 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Create Schedule Form */}
        <form
          onSubmit={handleCreate}
          className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 space-y-3 text-xs"
        >
          <h3 className="font-bold text-slate-200 flex items-center gap-1.5">
            <Plus className="w-4 h-4 text-sky-400" />
            Add Opt-In Schedule for &ldquo;{projectName}&rdquo;
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Task name (e.g. Nightly Tests)"
              className="bg-[#080c1a] border border-[#1b2544] rounded-lg px-2.5 py-2 text-slate-100 focus:outline-none focus:border-sky-400"
            />
            <select
              value={taskKind}
              onChange={(e) => setTaskKind(e.target.value as any)}
              className="bg-[#080c1a] border border-[#1b2544] rounded-lg px-2.5 py-2 text-slate-100 focus:outline-none focus:border-sky-400"
            >
              <option value="test_run">Recurring Test Run</option>
              <option value="repo_status">Repository Status Check</option>
              <option value="dependency_report">Dependency / Update Report</option>
            </select>
            <input
              type="text"
              value={scheduleExpr}
              onChange={(e) => setScheduleExpr(e.target.value)}
              placeholder="15m or */15 * * * *"
              className="bg-[#080c1a] border border-[#1b2544] rounded-lg px-2.5 py-2 text-slate-100 focus:outline-none focus:border-sky-400"
            />
            <input
              type="text"
              value={notifyChatId}
              onChange={(e) => setNotifyChatId(e.target.value)}
              placeholder="Telegram Chat ID (optional)"
              className="bg-[#080c1a] border border-[#1b2544] rounded-lg px-2.5 py-2 text-slate-100 focus:outline-none focus:border-sky-400"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={enableImmediately}
                onChange={(e) => setEnableImmediately(e.target.checked)}
                className="accent-sky-400"
              />
              <span>Enable task immediately</span>
            </label>
            <button
              type="submit"
              disabled={!name.trim()}
              className="px-4 py-1.5 bg-sky-400 hover:bg-sky-300 disabled:bg-[#141d38] disabled:text-slate-500 text-[#060914] font-bold rounded-lg"
            >
              Create Schedule
            </button>
          </div>
        </form>

        {/* Task List */}
        <div className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 space-y-3 text-xs">
          <h3 className="font-bold text-slate-200">Configured Tasks ({tasks.length})</h3>
          {tasks.length === 0 ? (
            <p className="text-slate-500">No scheduled tasks configured for this project.</p>
          ) : (
            <div className="space-y-2">
              {tasks.map((t) => (
                <div
                  key={t.id}
                  className="bg-[#080c1a] border border-[#1b2544] rounded-lg p-3 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-100">{t.name}</span>
                      <span className="px-2 py-0.5 rounded bg-[#152042] text-slate-300 text-[10px]">
                        {t.taskKind}
                      </span>
                      <code className="text-sky-400">{t.scheduleExpr}</code>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          t.lastStatus === "succeeded"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : t.lastStatus === "failed"
                              ? "bg-rose-500/20 text-rose-300"
                              : "bg-[#152042] text-slate-300"
                        }`}
                      >
                        {t.lastStatus}
                      </span>
                    </div>
                    {t.lastError && <p className="text-rose-400 text-[11px]">{t.lastError}</p>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleAction(t.id, "run-now")}
                      className="px-2.5 py-1 bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-400/40 rounded flex items-center gap-1"
                    >
                      <Play className="w-3 h-3" /> Run Now
                    </button>
                    {t.enabled ? (
                      <button
                        type="button"
                        onClick={() => handleAction(t.id, "pause")}
                        className="px-2.5 py-1 bg-[#152042] hover:bg-[#1d2b57] text-slate-200 rounded flex items-center gap-1"
                      >
                        <Pause className="w-3 h-3" /> Pause
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleAction(t.id, "resume")}
                        className="px-2.5 py-1 bg-[#152042] hover:bg-[#1d2b57] text-slate-200 rounded flex items-center gap-1"
                      >
                        <Play className="w-3 h-3" /> Resume
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleAction(t.id, "delete")}
                      className="px-2 py-1 bg-rose-950/60 hover:bg-rose-900/70 text-rose-300 border border-rose-500/40 rounded"
                      title="Delete schedule"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Runs */}
        {runs.length > 0 && (
          <div className="bg-[#0b1022] border border-[#1b2544] rounded-xl p-4 space-y-2 text-xs">
            <h3 className="font-bold text-slate-200">Recent Scheduled Runs</h3>
            <div className="space-y-2">
              {runs.map((r) => (
                <div
                  key={r.id}
                  className="bg-[#080c1a] border border-[#1b2544] rounded p-2.5 space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200">
                      Run <code>{r.id}</code> ({r.status})
                    </span>
                    <span className="text-slate-500 text-[11px]">{r.startedAt}</span>
                  </div>
                  {r.error && <p className="text-rose-400 text-[11px]">{r.error}</p>}
                  {r.output && (
                    <pre className="text-slate-300 text-[11px] whitespace-pre-wrap max-h-28 overflow-y-auto">
                      {r.output}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
