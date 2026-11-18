import React, { useState, useRef, useEffect } from "react";
import { Terminal as TerminalIcon, Play, Trash2, CornerDownLeft, Sparkles } from "lucide-react";
import { apiFetch } from "../api";

interface TerminalHistoryItem {
  id: string;
  command: string;
  output: string;
  timestamp: string;
  status: "success" | "error";
}

interface InteractiveTerminalProps {
  projectId: string;
  sessionId?: string | null;
}

export const InteractiveTerminal: React.FC<InteractiveTerminalProps> = ({
  projectId,
  sessionId,
}) => {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<TerminalHistoryItem[]>([
    {
      id: "init",
      command: "ls -la",
      output: "README.md\napp.py\npackage.json\nindex.js",
      timestamp: new Date().toLocaleTimeString(),
      status: "success",
    },
  ]);
  const [isExecuting, setIsExecuting] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, isExecuting]);

  const handleRunCommand = async (cmdToRun: string) => {
    if (!cmdToRun.trim() || isExecuting) return;

    setIsExecuting(true);
    const timestamp = new Date().toLocaleTimeString();

    try {
      const res = await apiFetch("/api/workspace/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: cmdToRun,
          projectId,
          sessionId: sessionId || undefined,
        }),
      });

      const data = await res.json();
      const output = data.output || data.error || "No output";

      setHistory((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          command: cmdToRun,
          output,
          timestamp,
          status: res.ok ? "success" : "error",
        },
      ]);
    } catch (err: any) {
      setHistory((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          command: cmdToRun,
          output: `Terminal Error: ${err.message}`,
          timestamp,
          status: "error",
        },
      ]);
    } finally {
      setIsExecuting(false);
      setCommand("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRunCommand(command);
    }
  };

  const QUICK_COMMANDS = [
    "ls -la",
    "python app.py",
    "node index.js",
    "cat README.md",
    "npm run test",
  ];

  return (
    <div className="flex flex-col h-full bg-[#060914] text-slate-100 font-mono">
      {/* Terminal Top Bar */}
      <div className="px-4 py-3 bg-[#0b1022] border-b border-[#1b2544] flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <TerminalIcon className="w-4 h-4 text-sky-400" />
          <span className="text-xs font-bold text-slate-200">
            NanoGem Sandbox Shell &mdash; <code className="text-sky-400">/workspace/</code>
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setHistory([])}
            className="px-2.5 py-1 bg-[#152042] hover:bg-[#1d2b57] text-slate-300 hover:text-white rounded text-xs flex items-center gap-1 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear Terminal</span>
          </button>
        </div>
      </div>

      {/* Quick Command Chips */}
      <div className="px-4 py-2 bg-[#090e1f] border-b border-[#1b2544] flex items-center space-x-2 overflow-x-auto text-xs">
        <span className="text-slate-500 font-bold flex-shrink-0">Quick Run:</span>
        {QUICK_COMMANDS.map((cmd, idx) => (
          <button
            key={idx}
            onClick={() => handleRunCommand(cmd)}
            disabled={isExecuting}
            className="px-2.5 py-1 bg-[#080c1a] hover:bg-[#152042] border border-[#1b2544] hover:border-sky-400/40 text-slate-300 hover:text-sky-300 rounded text-[11px] whitespace-nowrap transition-colors"
          >
            $ {cmd}
          </button>
        ))}
      </div>

      {/* Terminal Output Log Window */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 font-mono text-xs leading-relaxed bg-[#060914]">
        <div className="text-slate-500 text-[11px] border-b border-[#1b2544] pb-2">
          Interactive Terminal attached to NanoGem sandbox environment. All bash commands run inside <code className="text-slate-400">/workspace/</code>.
        </div>

        {history.map((item) => (
          <div key={item.id} className="space-y-1">
            {/* Command Line Prompt */}
            <div className="flex items-center space-x-2 text-slate-300">
              <span className="text-emerald-400 font-bold">sandbox@nanogem</span>
              <span className="text-slate-500">:</span>
              <span className="text-sky-400 font-bold">/workspace</span>
              <span className="text-slate-400">#</span>
              <span className="font-bold text-slate-100">{item.command}</span>
              <span className="text-[10px] text-slate-600 ml-auto">{item.timestamp}</span>
            </div>

            {/* Output */}
            {item.output && (
              <pre className="p-3 bg-[#0b1022] border border-[#1b2544] rounded text-slate-300 overflow-x-auto whitespace-pre-wrap">
                {item.output}
              </pre>
            )}
          </div>
        ))}

        {isExecuting && (
          <div className="flex items-center space-x-2 text-amber-400 text-xs">
            <Sparkles className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>Running bash command...</span>
          </div>
        )}

        <div ref={terminalEndRef} />
      </div>

      {/* Terminal Command Input Prompt */}
      <div className="p-3 bg-[#0b1022] border-t border-[#1b2544]">
        <div className="flex items-center space-x-2 bg-[#080c1a] border border-[#222e52] focus-within:border-sky-400/70 rounded-lg px-3 py-2 transition-colors">
          <span className="text-sky-400 font-bold text-xs">$</span>
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isExecuting}
            placeholder="Type bash command (e.g., python app.py, ls -la, npm start)..."
            className="flex-1 bg-transparent text-xs text-slate-100 placeholder-slate-500 font-mono focus:outline-none"
          />
          <button
            onClick={() => handleRunCommand(command)}
            disabled={!command.trim() || isExecuting}
            className="px-3 py-1 bg-sky-400 hover:bg-sky-300 disabled:bg-[#141d38] disabled:text-slate-500 text-[#060914] text-xs font-bold rounded flex items-center gap-1 transition-colors"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>Run</span>
          </button>
        </div>
      </div>
    </div>
  );
};
