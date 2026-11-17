import { exec, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import { existsSync, realpathSync } from "fs";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

export type ExecutionMode = "docker" | "host";

export interface SandboxConfig {
  executionMode: ExecutionMode;
  workspaceDir: string;
  dockerImage: string;
  dockerUser: string;
  dockerNetwork: string;
  dockerCpus: string;
  dockerMemory: string;
  dockerPidsLimit: number;
  dockerReadOnly: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface DockerStatus {
  available: boolean;
  imagePresent: boolean;
  serverVersion?: string;
  error?: string;
}

const DEFAULT_DOCKER_IMAGE = "nanogem-sandbox:latest";
const DEFAULT_DOCKER_USER = "1000:1000";
const DEFAULT_DOCKER_NETWORK = "none";
const DEFAULT_DOCKER_CPUS = "1.0";
const DEFAULT_DOCKER_MEMORY = "512m";
const DEFAULT_DOCKER_PIDS_LIMIT = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw || !raw.trim()) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name} "${trimmed}": expected a positive integer.`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} "${trimmed}": must be greater than 0.`);
  }
  return value;
}

function validateDockerUser(raw: string | undefined): string {
  const user = raw?.trim() || DEFAULT_DOCKER_USER;
  if (!/^([a-zA-Z0-9._-]+|\d+)(:([a-zA-Z0-9._-]+|\d+))?$/.test(user)) {
    throw new Error(
      `Invalid NANOGEM_DOCKER_USER "${user}": expected "<uid>:<gid>" or "<user>[:<group>]".`
    );
  }
  const parts = user.split(":");
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "0" || normalized === "root") {
      throw new Error(
        `Security Error: NANOGEM_DOCKER_USER ("${user}") must be a non-root user/UID.`
      );
    }
  }
  return user;
}

function validateDockerCpus(raw: string | undefined): string {
  const cpus = raw?.trim() || DEFAULT_DOCKER_CPUS;
  const parsed = Number(cpus);
  if (!/^\d+(\.\d+)?$/.test(cpus) || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid NANOGEM_DOCKER_CPUS "${cpus}": expected a positive number.`);
  }
  return cpus;
}

function validateDockerMemory(raw: string | undefined): string {
  const memory = raw?.trim() || DEFAULT_DOCKER_MEMORY;
  if (!/^[1-9]\d*[bkmg]?$/i.test(memory)) {
    throw new Error(
      `Invalid NANOGEM_DOCKER_MEMORY "${memory}": expected a positive Docker size such as "512m" or "1g".`
    );
  }
  return memory;
}

function validateSimpleToken(raw: string | undefined, fallback: string, name: string): string {
  const value = raw?.trim() || fallback;
  if (/[\s\0]/.test(value)) {
    throw new Error(`Invalid ${name}: must not contain whitespace or null bytes.`);
  }
  return value;
}

export function loadSandboxConfig(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env
): SandboxConfig {
  const rawMode = env.NANOGEM_EXECUTION_MODE?.trim().toLowerCase() || "docker";
  if (rawMode !== "docker" && rawMode !== "host") {
    throw new Error(
      `Invalid NANOGEM_EXECUTION_MODE "${rawMode}". Supported values are "docker" (default) or "host".`
    );
  }

  return {
    executionMode: rawMode,
    workspaceDir: path.resolve(workspaceDir),
    dockerImage: validateSimpleToken(
      env.NANOGEM_DOCKER_IMAGE,
      DEFAULT_DOCKER_IMAGE,
      "NANOGEM_DOCKER_IMAGE"
    ),
    dockerUser: validateDockerUser(env.NANOGEM_DOCKER_USER),
    dockerNetwork: validateSimpleToken(
      env.NANOGEM_DOCKER_NETWORK,
      DEFAULT_DOCKER_NETWORK,
      "NANOGEM_DOCKER_NETWORK"
    ),
    dockerCpus: validateDockerCpus(env.NANOGEM_DOCKER_CPUS),
    dockerMemory: validateDockerMemory(env.NANOGEM_DOCKER_MEMORY),
    dockerPidsLimit: parsePositiveInt(
      env.NANOGEM_DOCKER_PIDS_LIMIT,
      DEFAULT_DOCKER_PIDS_LIMIT,
      "NANOGEM_DOCKER_PIDS_LIMIT"
    ),
    dockerReadOnly: (env.NANOGEM_DOCKER_READ_ONLY?.trim() ?? "true").toLowerCase() !== "false",
    timeoutMs: parsePositiveInt(
      env.NANOGEM_COMMAND_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      "NANOGEM_COMMAND_TIMEOUT_MS"
    ),
    maxOutputBytes: parsePositiveInt(
      env.NANOGEM_MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES,
      "NANOGEM_MAX_OUTPUT_BYTES"
    ),
  };
}

export function buildDockerRunArgs(
  command: string,
  config: SandboxConfig,
  containerName: string
): string[] {
  const args: string[] = [
    "run",
    "--rm",
    "--init",
    "--name",
    containerName,
    "--workdir",
    "/workspace",
    "--mount",
    `type=bind,source=${config.workspaceDir},target=/workspace`,
    "--user",
    config.dockerUser,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--network",
    config.dockerNetwork,
    "--cpus",
    config.dockerCpus,
    "--memory",
    config.dockerMemory,
    "--memory-swap",
    config.dockerMemory,
    "--pids-limit",
    String(config.dockerPidsLimit),
  ];

  if (config.dockerReadOnly) {
    const numericMatch = /^(\d+)(?::(\d+))?$/.exec(config.dockerUser);
    const homeTmpfsOpts = numericMatch
      ? `rw,nosuid,nodev,size=64m,uid=${numericMatch[1]},gid=${numericMatch[2] ?? numericMatch[1]}`
      : "rw,nosuid,nodev,size=64m,mode=1777";

    args.push(
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
      "--tmpfs",
      `/home/sandbox:${homeTmpfsOpts}`
    );
  }

  // Pass only minimal, non-secret environment variables into the sandbox container.
  args.push(
    "-e",
    "HOME=/home/sandbox",
    "-e",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "-e",
    "LANG=C.UTF-8",
    "-e",
    "PYTHONDONTWRITEBYTECODE=1",
    "-e",
    "PIP_NO_CACHE_DIR=1",
    "-e",
    "NPM_CONFIG_CACHE=/home/sandbox/.npm",
    config.dockerImage,
    "/bin/bash",
    "-c",
    command
  );

  return args;
}

function isInsideDirectory(parentRealPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentRealPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves a user/agent supplied relative path inside workspaceDir while blocking
 * directory traversal, prefix bypasses, and symlink escapes outside sandbox_workspace.
 */
export async function resolveSafeWorkspacePath(
  workspaceDir: string,
  filePath: string
): Promise<string | null> {
  if (!filePath || typeof filePath !== "string" || filePath.includes("\0")) {
    return null;
  }

  if (!existsSync(workspaceDir)) {
    return null;
  }

  const workspaceReal = realpathSync(workspaceDir);
  const resolved = path.resolve(workspaceReal, filePath);

  if (!isInsideDirectory(workspaceReal, resolved) || resolved === workspaceReal) {
    return null;
  }

  // Walk up to the nearest existing ancestor and verify its realpath stays inside workspaceReal.
  let probe = resolved;
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      return null;
    }
    probe = parent;
  }

  try {
    const ancestorReal = await fs.realpath(probe);
    if (!isInsideDirectory(workspaceReal, ancestorReal)) {
      return null;
    }

    // If the target itself exists (including as a symlink), verify its realpath as well.
    try {
      const stat = await fs.lstat(resolved);
      if (stat.isSymbolicLink()) {
        const targetReal = await fs.realpath(resolved);
        if (!isInsideDirectory(workspaceReal, targetReal)) {
          return null;
        }
      }
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        // Dangling symlink at target path: block to avoid symlink-planting attacks.
        try {
          const linkStat = await fs.lstat(resolved);
          if (linkStat.isSymbolicLink()) {
            return null;
          }
        } catch {
          // Path genuinely does not exist yet (safe for file creation).
        }
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }

  return resolved;
}

function appendBounded(current: string, chunk: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  const remaining = maxBytes - Buffer.byteLength(current, "utf-8");
  if (remaining <= 0) {
    return { text: current, truncated: true };
  }
  const chunkStr = chunk.toString("utf-8");
  if (Buffer.byteLength(chunkStr, "utf-8") <= remaining) {
    return { text: current + chunkStr, truncated: false };
  }
  const sliced = chunk.subarray(0, remaining).toString("utf-8");
  return { text: current + sliced, truncated: true };
}

function formatCommandOutput(stdout: string, stderr: string, truncated: boolean): string {
  const combined = (stdout || "") + (stderr ? `\n[STDERR]:\n${stderr}` : "");
  const trimmed = combined.trim() || "Command executed successfully (no output).";
  return truncated ? `${trimmed}\n\n[Output truncated at limit]` : trimmed;
}

function cleanupDockerContainer(containerName: string): void {
  try {
    const killer = spawn("docker", ["rm", "-f", containerName], {
      stdio: "ignore",
      shell: false,
    });
    killer.on("error", () => {
      // Best-effort cleanup
    });
  } catch {
    // Best-effort cleanup
  }
}

async function executeInDocker(command: string, config: SandboxConfig): Promise<string> {
  const containerName = `nanogem-exec-${crypto.randomUUID()}`;
  const args = buildDockerRunArgs(command, config, containerName);

  return new Promise<string>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const finish = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(message);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      cleanupDockerContainer(containerName);
      child.kill("SIGKILL");
      finish(
        `Error: Command timed out after ${Math.round(config.timeoutMs / 1000)} seconds (container terminated).`
      );
    }, config.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk, config.maxOutputBytes);
      stdout = next.text;
      if (next.truncated) truncated = true;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, config.maxOutputBytes);
      stderr = next.text;
      if (next.truncated) truncated = true;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish(
          "Sandbox Error: Docker CLI ('docker') was not found on PATH. NanoGem requires Docker by default. Install/start Docker and run ./scripts/build-sandbox.sh, or explicitly set NANOGEM_EXECUTION_MODE=host to run without container isolation."
        );
        return;
      }
      finish(`Sandbox Error: Failed to start Docker container: ${err.message}`);
    });

    child.on("close", (code) => {
      if (timedOut) return;
      if (code === 0) {
        finish(formatCommandOutput(stdout, stderr, truncated));
        return;
      }
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      const hint =
        /Unable to find image|No such image/i.test(stderr)
          ? `\nHint: Build the sandbox image first with ./scripts/build-sandbox.sh (expected image: ${config.dockerImage}).`
          : /Cannot connect to the Docker daemon|is the docker daemon running/i.test(stderr)
            ? "\nHint: Ensure the Docker daemon is running."
            : "";
      finish(`Error executing command (exit code ${code ?? "unknown"}):\n${combined}${hint}`.trim());
    });
  });
}

function buildSanitizedHostEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: env.LANG || "C.UTF-8",
  };

  if (env.HOME) safeEnv.HOME = env.HOME;
  if (env.USERPROFILE) safeEnv.USERPROFILE = env.USERPROFILE;

  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) {
      if (env[key]) safeEnv[key] = env[key];
    }
  }

  return safeEnv;
}

async function executeOnHost(command: string, config: SandboxConfig): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: config.workspaceDir,
      timeout: config.timeoutMs,
      maxBuffer: config.maxOutputBytes,
      env: buildSanitizedHostEnv(),
    });
    return formatCommandOutput(stdout, stderr, false);
  } catch (error: any) {
    if (error.killed) {
      return `Error: Command timed out after ${Math.round(config.timeoutMs / 1000)} seconds.`;
    }
    return `Error executing command: ${error.message}\n${error.stderr || ""}`.trim();
  }
}

export async function executeSandboxCommand(
  command: string,
  config: SandboxConfig
): Promise<string> {
  if (typeof command !== "string" || !command.trim()) {
    return "Error: Command must be a non-empty string.";
  }
  if (config.executionMode === "host") {
    return executeOnHost(command, config);
  }
  return executeInDocker(command, config);
}

function runDockerProbe(args: string[], timeoutMs = 3000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr: "Docker command timed out" });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function checkDockerAvailability(config: SandboxConfig): Promise<DockerStatus> {
  const info = await runDockerProbe(["info", "--format", "{{.ServerVersion}}"]);
  if (!info.ok) {
    return {
      available: false,
      imagePresent: false,
      error: info.stderr || "Docker daemon is unavailable.",
    };
  }

  const image = await runDockerProbe(["image", "inspect", "--format", "{{.Id}}", config.dockerImage]);
  return {
    available: true,
    imagePresent: image.ok,
    serverVersion: info.stdout || undefined,
    error: image.ok
      ? undefined
      : `Sandbox image '${config.dockerImage}' not found. Run ./scripts/build-sandbox.sh.`,
  };
}
