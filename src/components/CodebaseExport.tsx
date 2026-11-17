import React, { useState, useEffect } from "react";
import {
  FileCode,
  Copy,
  Check,
  Download,
  Terminal,
  Box,
  ShieldAlert,
  ExternalLink,
} from "lucide-react";
import { NanoGeminiSource } from "../types";
import { apiFetch } from "../api";

export const CodebaseExport: React.FC = () => {
  const [source, setSource] = useState<NanoGeminiSource | null>(null);
  const [activeFile, setActiveFile] = useState<keyof NanoGeminiSource>("readme");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    apiFetch("/api/nanogemini/source")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setSource(data);
      })
      .catch((err) => console.error("Error loading source:", err));
  }, []);

  const handleCopy = () => {
    if (!source || !source[activeFile]) return;
    navigator.clipboard.writeText(source[activeFile]);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const FILE_TITLES: Record<keyof NanoGeminiSource, { name: string; desc: string }> = {
    readme: { name: "README.md", desc: "Project documentation, architecture breakdown & quickstart guide" },
    agentPy: { name: "agent.py", desc: "The core Gemini Agent brain & function calling execution loop" },
    dockerfile: { name: "Dockerfile", desc: "Docker sandbox environment configuration (Node.js 22 + Python 3 + Git)" },
    requirements: { name: "requirements.txt", desc: "Python SDK dependencies (google-genai, python-dotenv)" },
    envExample: { name: ".env.example", desc: "Environment secrets template" },
    startSandboxSh: { name: "start_sandbox.sh", desc: "Local shell launcher script" },
  };

  return (
    <div className="flex flex-col h-[calc(100vh-65px)] bg-slate-950 text-slate-100 font-mono overflow-y-auto">
      <div className="max-w-6xl mx-auto w-full p-6 space-y-6">
        {/* Banner */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <Box className="w-5 h-5 text-emerald-400" />
              <h2 className="text-lg font-bold text-slate-100">NanoGemini Source Codebase</h2>
            </div>
            <p className="text-xs text-slate-400">
              Inspect, copy, or export the full production-ready code for running NanoGemini on your host machine or cloud infrastructure.
            </p>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={handleCopy}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? "Copied" : "Copy Active File"}</span>
            </button>
          </div>
        </div>

        {/* Local Docker Setup Instructions */}
        <div className="bg-emerald-950/20 border border-emerald-500/30 rounded-xl p-4 space-y-2">
          <h3 className="text-xs font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-1.5">
            <Terminal className="w-4 h-4" /> Quickstart: Run NanoGemini Locally with Docker
          </h3>
          <p className="text-xs text-slate-300">
            Execute these commands in your terminal to launch the isolated Docker container:
          </p>
          <pre className="p-3 bg-slate-950 border border-slate-800/80 rounded-lg text-emerald-400 text-xs overflow-x-auto">
{`# 1. Build the hardened Docker sandbox image
./scripts/build-sandbox.sh

# 2. Run a command inside the isolated sandbox (no network, non-root, dropped caps)
docker run --rm --init \\
  --mount type=bind,source="$(pwd)/sandbox_workspace",target=/workspace \\
  --workdir /workspace \\
  --user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges:true \\
  --network=none --cpus=1.0 --memory=512m --memory-swap=512m --pids-limit=64 \\
  nanogem-sandbox:latest /bin/bash -c "ls -la"`}
          </pre>
        </div>

        {/* Code View Tabs & Container */}
        {source && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
            {/* Tab Bar */}
            <div className="bg-slate-950 border-b border-slate-800 p-2 flex flex-wrap gap-2">
              {(Object.keys(FILE_TITLES) as Array<keyof NanoGeminiSource>).map((key) => (
                <button
                  key={key}
                  onClick={() => setActiveFile(key)}
                  className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-2 transition-all ${
                    activeFile === key
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                  }`}
                >
                  <FileCode className="w-3.5 h-3.5" />
                  <span>{FILE_TITLES[key].name}</span>
                </button>
              ))}
            </div>

            {/* Description Bar */}
            <div className="px-4 py-2 bg-slate-900/80 border-b border-slate-800/60 flex items-center justify-between text-xs text-slate-400">
              <span>{FILE_TITLES[activeFile].desc}</span>
              <button
                onClick={() =>
                  handleDownloadFile(FILE_TITLES[activeFile].name, source[activeFile])
                }
                className="text-emerald-400 hover:underline flex items-center gap-1 text-xs"
              >
                <Download className="w-3 h-3" /> Download File
              </button>
            </div>

            {/* Code Body */}
            <pre className="p-4 text-xs font-mono text-slate-200 bg-slate-950 overflow-x-auto max-h-[500px] leading-relaxed">
              {source[activeFile]}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
