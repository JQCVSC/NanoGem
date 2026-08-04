import React, { useState } from "react";
import { Settings, X, RotateCcw, Check, Sparkles } from "lucide-react";
import { AgentSettings } from "../types";

interface AgentConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AgentSettings;
  onSaveSettings: (newSettings: AgentSettings) => void;
}

export const AgentConfigModal: React.FC<AgentConfigModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
}) => {
  const [model, setModel] = useState(settings.model);
  const [temperature, setTemperature] = useState(settings.temperature);
  const [systemInstruction, setSystemInstruction] = useState(
    settings.systemInstruction
  );

  if (!isOpen) return null;

  const handleSave = () => {
    onSaveSettings({
      ...settings,
      model,
      temperature,
      systemInstruction,
    });
    onClose();
  };

  const DEFAULT_SYSTEM_INSTRUCTION = `You are NanoGemini, an autonomous developer agent running inside a secure, isolated Docker sandbox.
You have the ability to execute bash terminal commands and write files directly to the file system.
Your working directory is restricted to \`/workspace/\`. 
If a user asks you to build an app, create the files, install the dependencies via bash, and verify it works.
Always think step-by-step. Use your tools immediately when needed without asking for permission.`;

  const handleResetDefault = () => {
    setModel("gemini-3.6-flash");
    setTemperature(0);
    setSystemInstruction(DEFAULT_SYSTEM_INSTRUCTION);
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 font-mono">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-xl w-full space-y-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center space-x-2">
            <Settings className="w-5 h-5 text-emerald-400" />
            <h2 className="text-sm font-bold text-slate-100">NanoGemini Sandbox Config</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Controls */}
        <div className="space-y-4 text-xs">
          {/* Model Selection */}
          <div className="space-y-1.5">
            <label className="text-slate-300 font-bold">Gemini Model Alias</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              <option value="gemini-3.6-flash">gemini-3.6-flash (Recommended: Ultra-fast agent speed)</option>
              <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview (Advanced reasoning & code logic)</option>
            </select>
          </div>

          {/* Temperature Slider */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-slate-300 font-bold">
              <span>Temperature ({temperature})</span>
              <span className="text-slate-500">0.0 = Deterministic</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full accent-emerald-500 cursor-pointer"
            />
          </div>

          {/* System Instructions */}
          <div className="space-y-1.5">
            <label className="text-slate-300 font-bold">Agent System Instructions</label>
            <textarea
              rows={6}
              value={systemInstruction}
              onChange={(e) => setSystemInstruction(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-slate-200 leading-relaxed focus:outline-none focus:border-emerald-500 resize-none"
            />
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-800">
          <button
            onClick={handleResetDefault}
            className="text-slate-400 hover:text-slate-200 flex items-center gap-1 text-xs"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Defaults</span>
          </button>

          <div className="flex space-x-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-lg text-xs"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Save Configuration</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
