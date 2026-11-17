import { exec, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import { existsSync, realpathSync } from "fs";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

export type ExecutionMode = "docker" | "host";
export type ContainerRuntimePreference = "auto" | "docker" | "podman";
export type ContainerRuntimeExecutable = "docker" | "podman";

export interface SandboxConfig {
  executionMode: ExecutionMode;
  containerRuntime: ContainerRuntimePreference;
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

export interface ContainerRuntimeStatus {
  configuredRuntime: ContainerRuntimePreference;
  selectedRuntime: ContainerRuntimeExecutable | null;
  available: boolean;
  imagePresent: boolean;
  image: string;
  network: string;
  networkEnabled: boolean;
  executionMode: ExecutionMode;
  serverVersion?: string;
  error?: string;
  remediation?: string;
}

export type DockerStatus = ContainerRuntimeStatus;

export interface RuntimeProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type RuntimeProbeFn = (
  runtime: ContainerRuntimeExecutable,
  args: string[]
) => Promise<RuntimeProbeResult>;

export interface SandboxRuntimeDeps {
  probe?: RuntimeProbeFn;
  spawnProcess?: typeof spawn;
}

export interface SandboxCommandResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
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

function validateContainerRuntime(raw: string | undefined): ContainerRuntimePreference {
  const value = raw?.trim().toLowerCase() || "auto";
  if (value !== "auto" && value !== "docker" && value !== "podman") {
    throw new Error(
      `Invalid NANOGEM_CONTAINER_RUNTIME "${value}". Supported values are "auto", "docker", or "podman".`
    );
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

  const containerRuntime = validateContainerRuntime(env.NANOGEM_CONTAINER_RUNTIME);
  const hasSandboxImage = env.NANOGEM_SANDBOX_IMAGE !== undefined && env.NANOGEM_SANDBOX_IMAGE.trim() !== "";
  const dockerImage = validateSimpleToken(
    hasSandboxImage ? env.NANOGEM_SANDBOX_IMAGE : env.NANOGEM_DOCKER_IMAGE,
    DEFAULT_DOCKER_IMAGE,
    hasSandboxImage ? "NANOGEM_SANDBOX_IMAGE" : "NANOGEM_DOCKER_IMAGE"
  );

  return {
    executionMode: rawMode,
    containerRuntime,
    workspaceDir: path.resolve(workspaceDir),
    dockerImage,
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

  // Walk every existing prefix segment from workspaceReal down to resolved so
  // intermediate symlinks (including dangling ones) cannot escape workspaceReal.
  const relSegments = path.relative(workspaceReal, resolved).split(path.sep).filter(Boolean);
  let currentPrefix = workspaceReal;
  for (const segment of relSegments) {
    currentPrefix = path.join(currentPrefix, segment);
    try {
      const segStat = await fs.lstat(currentPrefix);
      if (segStat.isSymbolicLink()) {
        const segReal = await fs.realpath(currentPrefix);
        if (!isInsideDirectory(workspaceReal, segReal)) {
          return null;
        }
      }
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        // Check if currentPrefix itself is a dangling symlink (lstat succeeds, realpath throws ENOENT).
        try {
          const linkStat = await fs.lstat(currentPrefix);
          if (linkStat.isSymbolicLink()) {
            return null;
          }
        } catch {
          // Segment genuinely does not exist yet (safe for new file creation).
        }
        break;
      }
      return null;
    }
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

function cleanupContainer(
  runtime: ContainerRuntimeExecutable,
  containerName: string,
  spawnImpl: typeof spawn = spawn
): void {
  try {
    const killer = spawnImpl(runtime, ["rm", "-f", containerName], {
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

export function buildContainerRunArgs(
  command: string,
  config: SandboxConfig,
  containerName: string
): string[] {
  return buildDockerRunArgs(command, config, containerName);
}

const RUNTIME_REMEDIATION =
  "Install Docker Desktop (https://docs.docker.com/get-docker/ or 'winget install -e --id Docker.DockerDesktop') " +
  "or Podman (https://podman.io/get-started or 'winget install -e --id RedHat.Podman' + 'podman machine init && podman machine start'), " +
  "then pull the sandbox image.";

async function probeEngineInfo(
  runtime: ContainerRuntimeExecutable,
  probeFn: RuntimeProbeFn
): Promise<RuntimeProbeResult> {
  const format =
    runtime === "docker" ? "{{.ServerVersion}}" : "{{.Version.Version}}";
  return probeFn(runtime, ["info", "--format", format]);
}

export async function resolveContainerRuntime(
  config: SandboxConfig,
  probeFn: RuntimeProbeFn = runRuntimeProbe
): Promise<{
  selectedRuntime: ContainerRuntimeExecutable | null;
  serverVersion?: string;
  error?: string;
  remediation?: string;
}> {
  if (config.containerRuntime === "docker") {
    const dockerInfo = await probeEngineInfo("docker", probeFn);
    if (dockerInfo.ok) {
      return { selectedRuntime: "docker", serverVersion: dockerInfo.stdout || undefined };
    }
    return {
      selectedRuntime: null,
      error: `Required container runtime 'docker' is unavailable (${dockerInfo.stderr || "Docker daemon not reachable"}).`,
      remediation: `Start Docker or install Docker Desktop, then pull '${config.dockerImage}'. ${RUNTIME_REMEDIATION}`,
    };
  }

  if (config.containerRuntime === "podman") {
    const podmanInfo = await probeEngineInfo("podman", probeFn);
    if (podmanInfo.ok) {
      return { selectedRuntime: "podman", serverVersion: podmanInfo.stdout || undefined };
    }
    return {
      selectedRuntime: null,
      error: `Required container runtime 'podman' is unavailable (${podmanInfo.stderr || "Podman engine not reachable"}).`,
      remediation: `Install/start Podman ('podman machine init && podman machine start'), then pull '${config.dockerImage}'. ${RUNTIME_REMEDIATION}`,
    };
  }

  // NANOGEM_CONTAINER_RUNTIME=auto: prefer docker if available, otherwise podman. Never fall back to host.
  const dockerInfo = await probeEngineInfo("docker", probeFn);
  if (dockerInfo.ok) {
    return { selectedRuntime: "docker", serverVersion: dockerInfo.stdout || undefined };
  }

  const podmanInfo = await probeEngineInfo("podman", probeFn);
  if (podmanInfo.ok) {
    return { selectedRuntime: "podman", serverVersion: podmanInfo.stdout || undefined };
  }

  return {
    selectedRuntime: null,
    error: "Neither Docker nor Podman container runtime is available.",
    remediation: RUNTIME_REMEDIATION,
  };
}

async function executeInContainerDetailed(
  command: string,
  config: SandboxConfig,
  deps: SandboxRuntimeDeps = {}
): Promise<SandboxCommandResult> {
  const probeFn = deps.probe ?? runRuntimeProbe;
  const spawnImpl = deps.spawnProcess ?? spawn;

  const resolved = await resolveContainerRuntime(config, probeFn);
  if (!resolved.selectedRuntime) {
    const message = `Sandbox Error: ${resolved.error} ${resolved.remediation || ""}`.trim();
    return { ok: false, output: message, exitCode: null, error: message };
  }

  const runtime = resolved.selectedRuntime;
  const containerName = `nanogem-exec-${crypto.randomUUID()}`;
  const args = buildContainerRunArgs(command, config, containerName);

  return new Promise<SandboxCommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawnImpl(runtime, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const finish = (result: SandboxCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      cleanupContainer(runtime, containerName, spawnImpl);
      child.kill("SIGKILL");
      const message = `Error: Command timed out after ${Math.round(config.timeoutMs / 1000)} seconds (${runtime} container terminated).`;
      finish({ ok: false, output: message, exitCode: null, error: message });
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
      const message = `Sandbox Error: Failed to start ${runtime} container: ${err.message}`;
      finish({ ok: false, output: message, exitCode: null, error: message });
    });

    child.on("close", (code) => {
      if (timedOut) return;
      if (code === 0) {
        finish({ ok: true, output: formatCommandOutput(stdout, stderr, truncated), exitCode: 0 });
        return;
      }
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      const hint =
        /Unable to find image|No such image|image not known/i.test(stderr)
          ? `\nHint: Pull or build the sandbox image first (expected image: ${config.dockerImage}; e.g. '${runtime} pull ${config.dockerImage}' or './scripts/build-sandbox.sh').`
          : /Cannot connect to the Docker daemon|is the docker daemon running|cannot connect to Podman/i.test(stderr)
            ? `\nHint: Ensure the ${runtime} daemon/machine is running.`
            : "";
      const message = `Error executing command via ${runtime} (exit code ${code ?? "unknown"}):\n${combined}${hint}`.trim();
      finish({ ok: false, output: message, exitCode: code, error: message });
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

async function executeOnHostDetailed(
  command: string,
  config: SandboxConfig
): Promise<SandboxCommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: config.workspaceDir,
      timeout: config.timeoutMs,
      maxBuffer: config.maxOutputBytes,
      env: buildSanitizedHostEnv(),
    });
    return { ok: true, output: formatCommandOutput(stdout, stderr, false), exitCode: 0 };
  } catch (error: any) {
    if (error.killed) {
      const message = `Error: Command timed out after ${Math.round(config.timeoutMs / 1000)} seconds.`;
      return { ok: false, output: message, exitCode: null, error: message };
    }
    const message = `Error executing command: ${error.message}\n${error.stderr || ""}`.trim();
    const exitCode = typeof error.code === "number" ? error.code : null;
    return { ok: false, output: message, exitCode, error: message };
  }
}

export async function executeSandboxCommandDetailed(
  command: string,
  config: SandboxConfig,
  deps: SandboxRuntimeDeps = {}
): Promise<SandboxCommandResult> {
  if (typeof command !== "string" || !command.trim()) {
    const message = "Error: Command must be a non-empty string.";
    return { ok: false, output: message, exitCode: null, error: message };
  }
  if (config.executionMode === "host") {
    return executeOnHostDetailed(command, config);
  }
  return executeInContainerDetailed(command, config, deps);
}

export async function executeSandboxCommand(
  command: string,
  config: SandboxConfig,
  deps: SandboxRuntimeDeps = {}
): Promise<string> {
  const result = await executeSandboxCommandDetailed(command, config, deps);
  return result.output;
}

function runRuntimeProbe(
  runtime: ContainerRuntimeExecutable,
  args: string[],
  timeoutMs = 3000
): Promise<RuntimeProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(runtime, args, {
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
      resolve({ ok: false, stdout, stderr: `${runtime} command timed out` });
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

export async function checkContainerRuntimeAvailability(
  config: SandboxConfig,
  probeFn: RuntimeProbeFn = runRuntimeProbe
): Promise<ContainerRuntimeStatus> {
  const networkEnabled = config.dockerNetwork.toLowerCase() !== "none";
  const resolved = await resolveContainerRuntime(config, probeFn);

  if (!resolved.selectedRuntime) {
    return {
      configuredRuntime: config.containerRuntime,
      selectedRuntime: null,
      available: false,
      imagePresent: false,
      image: config.dockerImage,
      network: config.dockerNetwork,
      networkEnabled,
      executionMode: config.executionMode,
      error: resolved.error,
      remediation: resolved.remediation,
    };
  }

  const runtime = resolved.selectedRuntime;
  const image = await probeFn(runtime, ["image", "inspect", "--format", "{{.Id}}", config.dockerImage]);
  return {
    configuredRuntime: config.containerRuntime,
    selectedRuntime: runtime,
    available: true,
    imagePresent: image.ok,
    image: config.dockerImage,
    network: config.dockerNetwork,
    networkEnabled,
    executionMode: config.executionMode,
    serverVersion: resolved.serverVersion,
    error: image.ok
      ? undefined
      : `Sandbox image '${config.dockerImage}' not found in ${runtime}.`,
    remediation: image.ok
      ? undefined
      : `Run '${runtime} pull ${config.dockerImage}' or './scripts/build-sandbox.sh'.`,
  };
}

export async function checkDockerAvailability(
  config: SandboxConfig,
  probeFn: RuntimeProbeFn = runRuntimeProbe
): Promise<DockerStatus> {
  return checkContainerRuntimeAvailability(config, probeFn);
}
