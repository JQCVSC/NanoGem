import React, { useState, useEffect } from "react";
import {
  Folder,
  File,
  FileCode,
  FileText,
  Plus,
  Trash2,
  Save,
  RefreshCw,
  FolderOpen,
  Eye,
  Code,
  Download,
  Check,
  CheckCircle2,
} from "lucide-react";
import { WorkspaceFile } from "../types";
import { apiFetch } from "../api";

interface FileWorkspaceProps {
  projectId: string;
  files: WorkspaceFile[];
  onRefreshFiles: () => void;
  onSaveFile: (path: string, content: string) => Promise<void>;
  onDeleteFile: (path: string) => Promise<void>;
}

export const FileWorkspace: React.FC<FileWorkspaceProps> = ({
  projectId,
  files,
  onRefreshFiles,
  onSaveFile,
  onDeleteFile,
}) => {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>("README.md");
  const [fileContent, setFileContent] = useState<string>("");
  const [isSaved, setIsSaved] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [newFileName, setNewFileName] = useState<string>("");
  const [showNewFileModal, setShowNewFileModal] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<"code" | "preview">("code");

  useEffect(() => {
    setSelectedFilePath((prev) => {
      if (files.some((f) => !f.isDirectory && f.path === prev)) return prev;
      const firstFile = files.find((f) => !f.isDirectory);
      return firstFile ? firstFile.path : null;
    });
  }, [projectId, files]);

  useEffect(() => {
    if (selectedFilePath) {
      loadFileContent(selectedFilePath);
    } else {
      setFileContent("");
    }
  }, [selectedFilePath, projectId]);

  const loadFileContent = async (path: string) => {
    setIsLoading(true);
    try {
      const res = await apiFetch(
        `/api/workspace/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
      );
      if (res.ok) {
        const data = await res.json();
        setFileContent(data.content || "");
        setIsSaved(true);
      } else {
        setFileContent("// Unable to load file content");
      }
    } catch (err) {
      setFileContent("// Error loading file");
    } finally {
      setIsLoading(false);
    }
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setFileContent(e.target.value);
    setIsSaved(false);
  };

  const handleSave = async () => {
    if (!selectedFilePath) return;
    await onSaveFile(selectedFilePath, fileContent);
    setIsSaved(true);
  };

  const handleCreateNewFile = async () => {
    if (!newFileName.trim()) return;
    const path = newFileName.startsWith("/") ? newFileName.slice(1) : newFileName;
    await onSaveFile(path, `# ${newFileName}\n`);
    setNewFileName("");
    setShowNewFileModal(false);
    setSelectedFilePath(path);
    onRefreshFiles();
  };

  const handleDelete = async (path: string) => {
    if (window.confirm(`Are you sure you want to delete /workspace/${path}?`)) {
      await onDeleteFile(path);
      if (selectedFilePath === path) {
        setSelectedFilePath(null);
        setFileContent("");
      }
      onRefreshFiles();
    }
  };

  const isHtml = selectedFilePath?.endsWith(".html");

  return (
    <div className="flex flex-col md:flex-row h-full bg-[#060914] text-slate-100 font-mono">
      {/* File Tree Left Sidebar */}
      <div className="w-full md:w-64 lg:w-72 bg-[#0b1022] border-r border-[#1b2544] flex flex-col flex-shrink-0">
        {/* Tree Header */}
        <div className="p-3 border-b border-[#1b2544] flex items-center justify-between text-xs font-bold text-slate-300">
          <span className="flex items-center gap-1.5 uppercase tracking-wider">
            <FolderOpen className="w-4 h-4 text-amber-400" />
            /workspace/
          </span>
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setShowNewFileModal(true)}
              title="Create File"
              className="p-1 hover:bg-[#152042] text-slate-400 hover:text-sky-400 rounded"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={onRefreshFiles}
              title="Refresh Workspace"
              className="p-1 hover:bg-[#152042] text-slate-400 hover:text-sky-400 rounded"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* File Tree List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1 text-xs">
          {files.length === 0 ? (
            <div className="p-4 text-slate-500 text-center">No files in /workspace/</div>
          ) : (
            files.map((item) => (
              <FileTreeNode
                key={item.path}
                node={item}
                selectedPath={selectedFilePath}
                onSelect={(path) => setSelectedFilePath(path)}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </div>

      {/* Code Editor & Preview Right Main Pane */}
      <div className="flex-1 flex flex-col bg-[#060914] overflow-hidden">
        {selectedFilePath ? (
          <>
            {/* Editor Top Bar */}
            <div className="px-4 py-2.5 bg-[#0b1022] border-b border-[#1b2544] flex items-center justify-between text-xs">
              <div className="flex items-center space-x-2">
                <FileCode className="w-4 h-4 text-sky-400" />
                <span className="font-bold text-slate-200">/workspace/{selectedFilePath}</span>
                {!isSaved && (
                  <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/20 text-amber-300 rounded border border-amber-500/30">
                    Unsaved changes
                  </span>
                )}
              </div>

              <div className="flex items-center space-x-2">
                {isHtml && (
                  <div className="flex bg-[#080c1a] p-0.5 rounded border border-[#1b2544]">
                    <button
                      onClick={() => setViewMode("code")}
                      className={`px-2 py-1 rounded flex items-center gap-1 ${
                        viewMode === "code"
                          ? "bg-sky-500/20 text-sky-300 font-bold"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <Code className="w-3 h-3" /> Code
                    </button>
                    <button
                      onClick={() => setViewMode("preview")}
                      className={`px-2 py-1 rounded flex items-center gap-1 ${
                        viewMode === "preview"
                          ? "bg-sky-500/20 text-sky-300 font-bold"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <Eye className="w-3 h-3" /> Preview
                    </button>
                  </div>
                )}

                <button
                  onClick={handleSave}
                  disabled={isSaved}
                  className="px-3 py-1 bg-sky-400 hover:bg-sky-300 disabled:bg-[#141d38] disabled:text-slate-500 text-[#060914] font-bold rounded flex items-center gap-1.5 transition-colors"
                >
                  {isSaved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                  <span>{isSaved ? "Saved" : "Save"}</span>
                </button>
              </div>
            </div>

            {/* Content Pane */}
            <div className="flex-1 relative overflow-hidden bg-[#060914]">
              {isLoading ? (
                <div className="p-6 text-slate-500 text-xs">Loading file content...</div>
              ) : viewMode === "preview" && isHtml ? (
                <iframe
                  title="HTML Preview"
                  srcDoc={fileContent}
                  className="w-full h-full bg-white"
                />
              ) : (
                <textarea
                  value={fileContent}
                  onChange={handleContentChange}
                  spellCheck={false}
                  className="w-full h-full p-4 bg-[#060914] text-slate-200 font-mono text-xs leading-relaxed focus:outline-none resize-none"
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-slate-500">
            <FileCode className="w-12 h-12 text-slate-700 mb-2" />
            <p className="text-sm">Select a file from the left sidebar to view or edit</p>
          </div>
        )}
      </div>

      {/* New File Modal */}
      {showNewFileModal && (
        <div className="fixed inset-0 bg-[#060914]/85 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0b1022] border border-[#222e52] rounded-xl p-6 max-w-md w-full space-y-4 shadow-2xl">
            <h3 className="font-mono text-sm font-bold text-slate-100">Create New File in /workspace/</h3>
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="e.g., server.js, index.html, scripts/test.py"
              className="w-full bg-[#080c1a] border border-[#1b2544] rounded-lg p-2.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-400"
            />
            <div className="flex justify-end space-x-2">
              <button
                onClick={() => setShowNewFileModal(false)}
                className="px-3 py-1.5 bg-[#152042] text-slate-300 hover:bg-[#1d2b57] rounded text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateNewFile}
                disabled={!newFileName.trim()}
                className="px-3 py-1.5 bg-sky-400 text-[#060914] font-bold hover:bg-sky-300 rounded text-xs"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface FileTreeNodeProps {
  node: WorkspaceFile;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
}

const FileTreeNode: React.FC<FileTreeNodeProps> = ({
  node,
  selectedPath,
  onSelect,
  onDelete,
}) => {
  const isSelected = selectedPath === node.path;

  if (node.isDirectory) {
    return (
      <div className="space-y-0.5">
        <div className="flex items-center space-x-1 py-1 px-2 text-slate-400 font-bold">
          <Folder className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <span className="truncate">{node.name}</span>
        </div>
        <div className="pl-3 border-l border-[#1b2544] space-y-0.5">
          {node.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => onSelect(node.path)}
      className={`group flex items-center justify-between py-1 px-2 rounded cursor-pointer transition-colors ${
        isSelected
          ? "bg-sky-500/15 text-sky-300 font-bold border border-sky-400/35"
          : "hover:bg-[#152042] text-slate-300"
      }`}
    >
      <div className="flex items-center space-x-1.5 truncate">
        <FileCode className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
        <span className="truncate">{node.name}</span>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(node.path);
        }}
        title="Delete File"
        className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 p-0.5 transition-opacity"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
};
