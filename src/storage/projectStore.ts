import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveSafeWorkspacePath,
  type SandboxConfig,
} from "../server/sandboxRuntime.ts";

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  workspacePath: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  workspacePath?: string;
}

function slugifyProjectName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

function isInsideOrSame(parentReal: string, candidatePath: string): boolean {
  const rel = path.relative(parentReal, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function pathsOverlap(pathA: string, pathB: string): boolean {
  return isInsideOrSame(pathA, pathB) || isInsideOrSame(pathB, pathA);
}

function mapProjectRow(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    workspacePath: String(row.workspace_path),
    isDefault: Number(row.is_default) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Validates that a requested project directory lives strictly inside approvedRoot
 * (rejecting traversal, root-itself, and symlink escapes).
 */
export function resolveApprovedProjectWorkspace(
  approvedRootDir: string,
  requestedPath: string
): string {
  if (!requestedPath || typeof requestedPath !== "string" || requestedPath.includes("\0")) {
    throw new Error("Invalid project workspace path.");
  }

  fs.mkdirSync(approvedRootDir, { recursive: true });
  const approvedRootReal = fs.realpathSync(approvedRootDir);

  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(approvedRootReal, requestedPath);

  const rel = path.relative(approvedRootReal, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Security Error: Project workspace must reside inside approved root (${approvedRootReal}).`
    );
  }

  // Walk existing segments to block symlinks pointing outside approvedRootReal.
  const segments = rel.split(path.sep).filter(Boolean);
  let prefix = approvedRootReal;
  for (const seg of segments) {
    prefix = path.join(prefix, seg);
    if (!fs.existsSync(prefix)) {
      try {
        const lstat = fs.lstatSync(prefix);
        if (lstat.isSymbolicLink()) {
          throw new Error("Security Error: Project path contains a dangling symlink.");
        }
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          throw err;
        }
      }
      break;
    }
    const realPrefix = fs.realpathSync(prefix);
    if (!isInsideOrSame(approvedRootReal, realPrefix)) {
      throw new Error("Security Error: Project workspace escapes approved root via symlink.");
    }
  }

  return candidate;
}

export class ProjectStore {
  private readonly db: DatabaseSync;
  public readonly approvedRoot: string;

  constructor(db: DatabaseSync, approvedRootDir: string) {
    this.db = db;
    fs.mkdirSync(approvedRootDir, { recursive: true });
    this.approvedRoot = fs.realpathSync(approvedRootDir);
  }

  ensureDefaultProject(defaultWorkspaceDir: string): ProjectRecord {
    const existing = this.getProjectById("default");
    fs.mkdirSync(defaultWorkspaceDir, { recursive: true });
    const resolvedDefault = fs.realpathSync(defaultWorkspaceDir);

    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, slug, workspace_path, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      .run("default", "Default Sandbox", "default", resolvedDefault, now, now);

    return this.getProjectById("default")!;
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, slug, workspace_path, is_default, created_at, updated_at
         FROM projects
         ORDER BY is_default DESC, updated_at DESC, created_at ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapProjectRow);
  }

  getProjectById(projectId: string): ProjectRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, slug, workspace_path, is_default, created_at, updated_at
         FROM projects WHERE id = ?`
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? mapProjectRow(row) : null;
  }

  createProject(input: CreateProjectInput): ProjectRecord {
    const name = input.name?.trim();
    if (!name) {
      throw new Error("Project name is required.");
    }

    const baseSlug = slugifyProjectName(name);
    let slug = baseSlug;
    let suffix = 1;
    while (this.db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug)) {
      suffix++;
      slug = `${baseSlug}-${suffix}`;
    }

    const requestedPath = input.workspacePath?.trim() || slug;
    const resolvedWorkspace = resolveApprovedProjectWorkspace(
      this.approvedRoot,
      requestedPath
    );

    const existingProjects = this.listProjects();
    for (const existing of existingProjects) {
      const existingReal = fs.existsSync(existing.workspacePath)
        ? fs.realpathSync(existing.workspacePath)
        : existing.workspacePath;
      if (pathsOverlap(existingReal, resolvedWorkspace)) {
        throw new Error(
          `Project workspace conflicts with existing project "${existing.name}" (${existing.id}).`
        );
      }
    }

    fs.mkdirSync(resolvedWorkspace, { recursive: true });
    const canonicalWorkspace = fs.realpathSync(resolvedWorkspace);
    const id = `proj_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO projects (id, name, slug, workspace_path, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, name, slug, canonicalWorkspace, now, now);

    return this.getProjectById(id)!;
  }

  touchProject(projectId: string): void {
    this.db
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), projectId);
  }

  async resolveProjectFile(
    projectId: string,
    relativeFilePath: string
  ): Promise<string | null> {
    const project = this.getProjectById(projectId);
    if (!project) return null;
    return resolveSafeWorkspacePath(project.workspacePath, relativeFilePath);
  }

  buildSandboxConfigForProject(
    baseConfig: SandboxConfig,
    projectId: string
  ): SandboxConfig {
    const project = this.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found.`);
    }
    return {
      ...baseConfig,
      workspaceDir: project.workspacePath,
    };
  }
}
