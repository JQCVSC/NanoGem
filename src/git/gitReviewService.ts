import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const MAX_DIFF_BYTES = 256 * 1024; // 256 KiB

export interface GitFileStatusEntry {
  path: string;
  indexStatus: string;
  workTreeStatus: string;
  label: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
}

export interface GitStatusResult {
  isGitRepo: boolean;
  branch: string | null;
  headCommit: string | null;
  clean: boolean;
  hasUncommittedChanges: boolean;
  entries: GitFileStatusEntry[];
  message?: string;
}

export interface GitDiffResult {
  isGitRepo: boolean;
  diff: string;
  untrackedFiles: string[];
  truncated: boolean;
  message?: string;
}

function buildSanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

function runGit(
  cwd: string,
  args: string[],
  maxBytes = MAX_DIFF_BYTES
): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSanitizedGitEnv(),
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = maxBytes - Buffer.byteLength(stdout, "utf-8");
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const str = chunk.toString("utf-8");
      if (Buffer.byteLength(str, "utf-8") <= remaining) {
        stdout += str;
      } else {
        stdout += chunk.subarray(0, remaining).toString("utf-8");
        truncated = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) {
        stderr += chunk.toString("utf-8");
      }
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ code, stdout, stderr: stderr.trim(), truncated });
    });
  });
}

/**
 * Ensures we only operate on a Git repository whose root IS workspaceDir itself,
 * never walking up into a parent repository (such as the NanoGem host repo).
 */
async function isIsolatedGitRepo(workspaceDir: string): Promise<boolean> {
  if (!fs.existsSync(workspaceDir)) return false;
  const dotGit = path.join(workspaceDir, ".git");
  if (!fs.existsSync(dotGit)) return false;

  const res = await runGit(workspaceDir, ["rev-parse", "--show-toplevel"]);
  if (res.code !== 0) return false;

  const topReal = fs.realpathSync(path.resolve(res.stdout.trim()));
  const wsReal = fs.realpathSync(workspaceDir);
  return topReal === wsReal;
}

export function validateBranchName(rawName: string): string {
  const name = rawName?.trim();
  if (!name) {
    throw new Error("Branch name is required.");
  }
  if (
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.includes("..") ||
    name.includes("@{") ||
    name.endsWith(".lock") ||
    !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(name)
  ) {
    throw new Error(
      `Invalid branch name "${name}": must contain only letters, numbers, '.', '_', '-', or '/' without traversal or leading '-'`
    );
  }
  return name;
}

function classifyStatus(indexStatus: string, workTreeStatus: string): GitFileStatusEntry["label"] {
  if (indexStatus === "?" && workTreeStatus === "?") return "untracked";
  if (indexStatus === "U" || workTreeStatus === "U") return "conflicted";
  if (indexStatus === "A" || workTreeStatus === "A") return "added";
  if (indexStatus === "D" || workTreeStatus === "D") return "deleted";
  if (indexStatus === "R" || workTreeStatus === "R") return "renamed";
  return "modified";
}

export async function getGitStatus(workspaceDir: string): Promise<GitStatusResult> {
  if (!(await isIsolatedGitRepo(workspaceDir))) {
    return {
      isGitRepo: false,
      branch: null,
      headCommit: null,
      clean: true,
      hasUncommittedChanges: false,
      entries: [],
      message: "Project workspace is not a Git repository.",
    };
  }

  const branchRes = await runGit(workspaceDir, ["symbolic-ref", "--short", "HEAD"]);
  const headRes = await runGit(workspaceDir, ["rev-parse", "--short", "HEAD"]);
  const statusRes = await runGit(workspaceDir, ["status", "--porcelain=v1"]);
  if (statusRes.code !== 0) {
    throw new Error(statusRes.stderr || "Failed to read git status.");
  }

  const entries: GitFileStatusEntry[] = [];
  for (const line of statusRes.stdout.split(/\r?\n/)) {
    if (!line || line.length < 4) continue;
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const filePath = line.slice(3).trim();
    entries.push({
      path: filePath,
      indexStatus,
      workTreeStatus,
      label: classifyStatus(indexStatus, workTreeStatus),
    });
  }

  return {
    isGitRepo: true,
    branch: branchRes.code === 0 ? branchRes.stdout.trim() : "HEAD",
    headCommit: headRes.code === 0 ? headRes.stdout.trim() : null,
    clean: entries.length === 0,
    hasUncommittedChanges: entries.length > 0,
    entries,
  };
}

export async function getGitDiff(workspaceDir: string): Promise<GitDiffResult> {
  if (!(await isIsolatedGitRepo(workspaceDir))) {
    return {
      isGitRepo: false,
      diff: "",
      untrackedFiles: [],
      truncated: false,
      message: "Project workspace is not a Git repository.",
    };
  }

  const status = await getGitStatus(workspaceDir);
  const untrackedFiles = status.entries
    .filter((e) => e.label === "untracked")
    .map((e) => e.path);

  const unstaged = await runGit(workspaceDir, ["diff", "--no-color"]);
  const staged = await runGit(workspaceDir, ["diff", "--cached", "--no-color"]);

  const sections: string[] = [];
  if (staged.stdout.trim()) {
    sections.push(`# Staged changes\n${staged.stdout.trimEnd()}`);
  }
  if (unstaged.stdout.trim()) {
    sections.push(`# Unstaged changes\n${unstaged.stdout.trimEnd()}`);
  }

  return {
    isGitRepo: true,
    diff: sections.join("\n\n"),
    untrackedFiles,
    truncated: unstaged.truncated || staged.truncated,
  };
}

export async function createGitBranch(
  workspaceDir: string,
  rawBranchName: string
): Promise<{ branch: string }> {
  if (!(await isIsolatedGitRepo(workspaceDir))) {
    throw new Error("Project workspace is not a Git repository.");
  }

  const branchName = validateBranchName(rawBranchName);
  const checkRes = await runGit(workspaceDir, ["check-ref-format", "--branch", branchName]);
  if (checkRes.code !== 0) {
    throw new Error(`Invalid Git branch name "${branchName}".`);
  }

  const res = await runGit(workspaceDir, ["checkout", "-b", branchName]);
  if (res.code !== 0) {
    throw new Error(res.stderr || `Failed to create branch "${branchName}".`);
  }
  return { branch: branchName };
}

export async function revertGitWorkspace(
  workspaceDir: string,
  options: { confirm: boolean }
): Promise<{ reverted: boolean; status: GitStatusResult }> {
  if (options?.confirm !== true) {
    throw new Error("Explicit confirmation (confirm=true) is required before reverting workspace changes.");
  }
  if (!(await isIsolatedGitRepo(workspaceDir))) {
    throw new Error("Project workspace is not a Git repository.");
  }

  const hasHead = (await runGit(workspaceDir, ["rev-parse", "--verify", "HEAD"])).code === 0;
  if (hasHead) {
    const resetRes = await runGit(workspaceDir, ["reset", "--hard", "HEAD"]);
    if (resetRes.code !== 0) {
      throw new Error(resetRes.stderr || "Failed to reset tracked files.");
    }
  } else {
    await runGit(workspaceDir, ["rm", "-rf", "--cached", "--ignore-unmatch", "."]);
  }

  const cleanRes = await runGit(workspaceDir, ["clean", "-fd"]);
  if (cleanRes.code !== 0) {
    throw new Error(cleanRes.stderr || "Failed to clean untracked files.");
  }

  return {
    reverted: true,
    status: await getGitStatus(workspaceDir),
  };
}

export async function commitGitChanges(
  workspaceDir: string,
  options: { message: string; confirm: boolean }
): Promise<{ commitHash: string; message: string; status: GitStatusResult }> {
  if (options?.confirm !== true) {
    throw new Error("Explicit confirmation (confirm=true) is required before committing changes.");
  }
  if (!(await isIsolatedGitRepo(workspaceDir))) {
    throw new Error("Project workspace is not a Git repository.");
  }

  const message = options.message?.trim();
  if (!message) {
    throw new Error("Commit message is required.");
  }

  const statusBefore = await getGitStatus(workspaceDir);
  if (statusBefore.clean) {
    throw new Error("Working tree is clean; nothing to commit.");
  }

  const addRes = await runGit(workspaceDir, ["add", "-A"]);
  if (addRes.code !== 0) {
    throw new Error(addRes.stderr || "Failed to stage changes.");
  }

  const commitRes = await runGit(workspaceDir, [
    "-c",
    "user.name=NanoGem User",
    "-c",
    "user.email=nanogem@local",
    "commit",
    "-m",
    message,
  ]);
  if (commitRes.code !== 0) {
    throw new Error(commitRes.stderr || "Failed to commit changes.");
  }

  const hashRes = await runGit(workspaceDir, ["rev-parse", "--short", "HEAD"]);
  return {
    commitHash: hashRes.stdout.trim(),
    message,
    status: await getGitStatus(workspaceDir),
  };
}
