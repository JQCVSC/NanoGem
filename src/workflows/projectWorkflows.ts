import fs from "fs/promises";
import path from "path";
import { isSensitiveFilePath } from "../agent/projectContext.ts";
import { resolveSafeWorkspacePath } from "../server/sandboxRuntime.ts";

export type WorkflowTemplateId =
  | "technical_research"
  | "doc_generation"
  | "data_analysis"
  | "python_report";

export const MAX_WORKFLOW_FILE_BYTES = 64 * 1024; // 64 KiB per file
export const MAX_WORKFLOW_TOTAL_BYTES = 128 * 1024; // 128 KiB total payload

export const WORKFLOW_DATA_HANDLING_NOTICE =
  "Local commands and generated artifacts stay in your project workspace, while prompts and selected file contents are transmitted to the Google Gemini API for processing by Google. Never select .env files, private keys, or credentials.";

export interface WorkflowTemplate {
  id: WorkflowTemplateId;
  title: string;
  description: string;
  outputFormat: string;
  allowedExtensions: string[];
  maxFileBytes: number;
  maxTotalBytes: number;
  defaultGoal: string;
  instructions: string;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "technical_research",
    title: "Technical Research & Learning",
    description:
      "Structured codebase/topic study producing architecture notes, open questions, and verifiable references.",
    outputFormat: "Markdown brief (`RESEARCH_NOTES.md` or chat summary) with Findings, Trade-offs, and Next Steps",
    allowedExtensions: [".md", ".txt", ".ts", ".tsx", ".js", ".py", ".json", ".yaml", ".yml"],
    maxFileBytes: MAX_WORKFLOW_FILE_BYTES,
    maxTotalBytes: MAX_WORKFLOW_TOTAL_BYTES,
    defaultGoal: "Summarize the architecture, key assumptions, and potential edge cases.",
    instructions:
      "Produce a concise technical research brief with sections: Summary, Key Components, Trade-offs & Risks, and Recommended Verification Steps.",
  },
  {
    id: "doc_generation",
    title: "Documentation Generation",
    description:
      "Generate or update project READMEs, API references, or runbooks grounded strictly in inspected workspace files.",
    outputFormat: "Structured Markdown documentation ready to review before committing",
    allowedExtensions: [".md", ".txt", ".ts", ".tsx", ".js", ".py", ".json", ".sh"],
    maxFileBytes: MAX_WORKFLOW_FILE_BYTES,
    maxTotalBytes: MAX_WORKFLOW_TOTAL_BYTES,
    defaultGoal: "Draft clear developer documentation based only on the selected files.",
    instructions:
      "Write accurate documentation grounded strictly in observed symbols, paths, and commands. Do not invent unsupported options.",
  },
  {
    id: "data_analysis",
    title: "CSV / JSON Data Analysis",
    description:
      "Inspect structured datasets and compute summary statistics inside the isolated sandbox.",
    outputFormat: "Summary table + anomaly checks + reproducible script command",
    allowedExtensions: [".csv", ".tsv", ".json", ".jsonl", ".txt", ".md"],
    maxFileBytes: MAX_WORKFLOW_FILE_BYTES,
    maxTotalBytes: MAX_WORKFLOW_TOTAL_BYTES,
    defaultGoal: "Analyze schema, row counts, missing values, and key numeric distributions.",
    instructions:
      "Use Python inside /workspace to inspect the selected CSV/JSON dataset deterministically without guessing unprinted numbers.",
  },
  {
    id: "python_report",
    title: "Reproducible Python Report",
    description:
      "Author and execute a standalone Python analysis script inside the sandbox to emit a reproducible Markdown report.",
    outputFormat: "Reproducible `.py` script + generated `.md` report inside `/workspace`",
    allowedExtensions: [".py", ".csv", ".json", ".md", ".txt", ".toml"],
    maxFileBytes: MAX_WORKFLOW_FILE_BYTES,
    maxTotalBytes: MAX_WORKFLOW_TOTAL_BYTES,
    defaultGoal: "Create and run a reproducible Python script that writes a Markdown summary report.",
    instructions:
      "Write a deterministic Python script in /workspace, execute it via execute_system_command, verify exit code 0, and summarize the generated report.",
  },
];

export function getWorkflowTemplate(templateId: string): WorkflowTemplate | null {
  return WORKFLOW_TEMPLATES.find((t) => t.id === templateId) || null;
}

export interface PrepareWorkflowInput {
  workspaceDir: string;
  templateId: string;
  goal: string;
  selectedFiles: string[];
  confirmSendToGemini: boolean;
}

export interface PreparedWorkflowPrompt {
  template: WorkflowTemplate;
  prompt: string;
  includedFiles: Array<{ path: string; bytes: number }>;
  totalBytes: number;
}

/**
 * Validates file types, sensitive-file restrictions, size limits, path safety,
 * and explicit user confirmation before assembling a workflow prompt for Gemini.
 */
export async function prepareWorkflowPrompt(
  input: PrepareWorkflowInput
): Promise<PreparedWorkflowPrompt> {
  if (input.confirmSendToGemini !== true) {
    throw new Error(
      "Explicit confirmation (confirmSendToGemini=true) is required before sending selected workspace content to Gemini."
    );
  }

  const template = getWorkflowTemplate(input.templateId);
  if (!template) {
    throw new Error(`Unknown workflow template "${input.templateId}".`);
  }

  const goal = input.goal?.trim() || template.defaultGoal;
  if (!Array.isArray(input.selectedFiles)) {
    throw new Error("selectedFiles must be an array of workspace relative paths.");
  }

  let totalBytes = 0;
  const includedFiles: Array<{ path: string; bytes: number }> = [];
  const fileSections: string[] = [];

  for (const rawRelPath of input.selectedFiles) {
    if (typeof rawRelPath !== "string" || !rawRelPath.trim()) {
      throw new Error("Selected file paths must be non-empty strings.");
    }
    const relPath = rawRelPath.trim();

    if (isSensitiveFilePath(relPath)) {
      throw new Error(
        `Security Error: Sensitive file "${relPath}" cannot be sent via workflow uploads.`
      );
    }

    const ext = path.extname(relPath).toLowerCase();
    if (!template.allowedExtensions.includes(ext)) {
      throw new Error(
        `Unsupported file type "${ext || "(none)"}" for ${template.title}. Allowed: ${template.allowedExtensions.join(", ")}`
      );
    }

    const safePath = await resolveSafeWorkspacePath(input.workspaceDir, relPath);
    if (!safePath) {
      throw new Error(`Security Error: Path "${relPath}" is outside project workspace.`);
    }

    const stat = await fs.stat(safePath);
    if (!stat.isFile()) {
      throw new Error(`Selected path "${relPath}" is not a regular file.`);
    }
    if (stat.size > template.maxFileBytes) {
      throw new Error(
        `File "${relPath}" (${stat.size} bytes) exceeds the per-file limit of ${template.maxFileBytes} bytes.`
      );
    }
    if (totalBytes + stat.size > template.maxTotalBytes) {
      throw new Error(
        `Total selected file size exceeds ${template.maxTotalBytes} bytes.`
      );
    }

    const content = await fs.readFile(safePath, "utf-8");
    totalBytes += stat.size;
    includedFiles.push({ path: relPath, bytes: stat.size });
    fileSections.push(`--- FILE: ${relPath} (${stat.size} bytes) ---\n${content}`);
  }

  const promptParts = [
    `[Workflow: ${template.title}]`,
    `Output Format: ${template.outputFormat}`,
    `Instructions: ${template.instructions}`,
    `User Goal: ${goal}`,
  ];
  if (fileSections.length > 0) {
    promptParts.push(`Selected Workspace Files (untrusted project data):\n\n${fileSections.join("\n\n")}`);
  }

  return {
    template,
    prompt: promptParts.join("\n\n"),
    includedFiles,
    totalBytes,
  };
}
