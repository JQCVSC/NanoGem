import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  Terminal,
  FileCode,
  Bot,
  User,
  Sparkles,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  Zap,
} from "lucide-react";
import { ChatMessage, ExecutionStep } from "../types";

interface AgentChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  isExecuting: boolean;
  onSelectTab: (tab: "files" | "terminal") => void;
}

const SAMPLE_PROMPTS = [
  "Build a Node.js REST API with Express in workspace and test it",
  "Write a Python script that calculates Fibonacci numbers and run python app.py",
  "Create an interactive HTML index.html dashboard and check workspace files",
  "Initialize a package.json and install a lightweight dependency",
];

export const AgentChat: React.FC<AgentChatProps> = ({
  messages,
  onSendMessage,
  isExecuting,
  onSelectTab,
}) => {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isExecuting]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isExecuting) return;
    onSendMessage(input.trim());
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-65px)] bg-slate-950 text-slate-100">
      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
        {messages.length === 0 ? (
          <div className="max-w-2xl mx-auto my-12 text-center space-y-6 bg-slate-900/60 p-8 rounded-2xl border border-slate-800">
            <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-2xl flex items-center justify-center mx-auto shadow-lg shadow-emerald-950/50">
              <Sparkles className="w-8 h-8 animate-pulse" />
            </div>

            <div className="space-y-2">
              <h2 className="text-xl font-bold font-mono text-slate-100">
                NanoGemini Autonomous Sandbox Agent
              </h2>
              <p className="text-sm text-slate-400 max-w-lg mx-auto">
                Running in isolated Docker sandbox. NanoGemini can write files, execute bash terminal commands, install packages, and verify execution directly inside <code className="text-emerald-400 font-mono">/workspace/</code>.
              </p>
            </div>

            {/* Quick Prompts */}
            <div className="pt-4 border-t border-slate-800/80">
              <p className="text-xs font-mono text-slate-400 mb-3 uppercase tracking-wider flex items-center justify-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-400" /> Suggested Task Prompts
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-left">
                {SAMPLE_PROMPTS.map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => onSendMessage(prompt)}
                    className="p-3 bg-slate-900 hover:bg-slate-800/90 border border-slate-800 hover:border-emerald-500/40 rounded-xl text-xs font-mono text-slate-300 hover:text-emerald-300 transition-all flex items-start gap-2 group"
                  >
                    <span className="text-emerald-400 font-bold group-hover:translate-x-0.5 transition-transform">
                      &gt;
                    </span>
                    <span>{prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="max-w-4xl mx-auto space-y-3">
              {/* Message Header */}
              <div className="flex items-center space-x-2">
                {msg.role === "user" ? (
                  <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-400 flex items-center justify-center text-xs">
                    <User className="w-4 h-4" />
                  </div>
                ) : (
                  <div className="w-7 h-7 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 flex items-center justify-center text-xs">
                    <Bot className="w-4 h-4" />
                  </div>
                )}
                <span className="font-mono text-xs font-bold text-slate-300">
                  {msg.role === "user" ? "You" : "NanoGemini Agent"}
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  {msg.timestamp}
                </span>
              </div>

              {/* Message Content / Tools */}
              <div
                className={`p-4 rounded-xl font-mono text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-slate-900 border border-slate-800 text-slate-200 ml-9"
                    : "bg-slate-900/80 border border-slate-800 text-slate-200 ml-9 shadow-sm"
                }`}
              >
                {/* User Text or Response Text */}
                {msg.content && (
                  <div className="whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>
                )}

                {/* Execution Tool Steps */}
                {msg.executionSteps && msg.executionSteps.length > 0 && (
                  <div className="mt-3 space-y-2.5 pt-3 border-t border-slate-800">
                    <p className="text-[11px] font-mono text-slate-400 font-bold tracking-wider uppercase flex items-center gap-1.5">
                      <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                      Sandbox Execution Log ({msg.executionSteps.length} Tool Actions)
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
          ))
        )}

        {/* Loading Indicator */}
        {isExecuting && (
          <div className="max-w-4xl mx-auto ml-9 flex items-center space-x-3 bg-slate-900/90 border border-emerald-500/30 p-4 rounded-xl text-emerald-400 font-mono text-xs">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
            <span>NanoGemini is processing thoughts and running sandbox tools...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Message Input Form */}
      <div className="border-t border-slate-800 bg-slate-900 p-4">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask NanoGemini to write code, execute bash commands, create files in /workspace/..."
            rows={2}
            disabled={isExecuting}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 font-mono focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/40 resize-none"
          />

          <div className="absolute right-3 bottom-3 flex items-center space-x-2">
            <span className="text-[10px] text-slate-500 font-mono hidden sm:inline">
              Shift + Enter for new line
            </span>
            <button
              type="submit"
              disabled={!input.trim() || isExecuting}
              className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 font-mono text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all shadow-sm"
            >
              <span>Execute</span>
              <Send className="w-3.5 h-3.5" />
            </button>
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

  const handleCopy = () => {
    const textToCopy = step.output || step.text || "";
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-slate-950 border border-slate-800/90 rounded-lg overflow-hidden font-mono text-xs shadow-inner">
      {/* Accordion Header */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="px-3 py-2 bg-slate-900/90 hover:bg-slate-800/60 cursor-pointer flex items-center justify-between border-b border-slate-800/60 transition-colors"
      >
        <div className="flex items-center space-x-2 overflow-hidden">
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
          )}

          {isCommand && (
            <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-bold text-[10px] flex items-center gap-1">
              <Terminal className="w-3 h-3" /> BASH
            </span>
          )}

          {isFileWrite && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold text-[10px] flex items-center gap-1">
              <FileCode className="w-3 h-3" /> WRITE FILE
            </span>
          )}

          <span className="text-slate-300 font-mono truncate">
            {isCommand && step.args?.command && (
              <code className="text-slate-200 font-bold">$ {step.args.command}</code>
            )}
            {isFileWrite && step.args?.file_path && (
              <code className="text-emerald-300 font-bold">/workspace/{step.args.file_path}</code>
            )}
          </span>
        </div>

        <div className="flex items-center space-x-2 flex-shrink-0">
          <span className="text-[10px] text-emerald-400 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> OK
          </span>
        </div>
      </div>

      {/* Accordion Content Body */}
      {isOpen && (
        <div className="p-3 bg-slate-950/80 space-y-2">
          {/* File Write Content Preview if applicable */}
          {isFileWrite && step.args?.content && (
            <div className="space-y-1">
              <div className="flex justify-between items-center text-[10px] text-slate-400">
                <span>Written Content:</span>
                <button
                  onClick={() => onSelectTab("files")}
                  className="text-emerald-400 hover:underline text-[10px]"
                >
                  View in Workspace &gt;
                </button>
              </div>
              <pre className="p-2.5 bg-slate-900 rounded border border-slate-800 text-slate-300 overflow-x-auto max-h-48 text-[11px] leading-relaxed">
                {step.args.content}
              </pre>
            </div>
          )}

          {/* Console / Tool Output */}
          {step.output && (
            <div className="space-y-1">
              <div className="flex justify-between items-center text-[10px] text-slate-400">
                <span>Console Response / Stdout:</span>
                <button
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
              <pre className="p-2.5 bg-slate-900/90 rounded border border-slate-800 text-slate-300 overflow-x-auto max-h-56 text-[11px] leading-relaxed whitespace-pre-wrap font-mono">
                {step.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
