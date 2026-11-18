import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildContainerRunArgs,
  buildDockerRunArgs,
  checkContainerRuntimeAvailability,
  executeSandboxCommand,
  executeSandboxCommandDetailed,
  loadSandboxConfig,
  resolveContainerRuntime,
  resolveSafeWorkspacePath,
  type ContainerRuntimeExecutable,
  type RuntimeProbeFn,
} from "../src/server/sandboxRuntime.ts";
import {
  constantTimeTokenEqual,
  loadServerSecurityConfig,
} from "../src/server/auth.ts";

test("loadSandboxConfig defaults to hardened docker execution", () => {
  const cfg = loadSandboxConfig("/tmp/nanogem/sandbox_workspace", {});
  assert.equal(cfg.executionMode, "docker");
  assert.equal(cfg.dockerImage, "nanogem-sandbox:latest");
  assert.equal(cfg.dockerUser, "1000:1000");
  assert.equal(cfg.dockerNetwork, "none");
  assert.equal(cfg.dockerCpus, "1.0");
  assert.equal(cfg.dockerMemory, "512m");
  assert.equal(cfg.dockerPidsLimit, 64);
  assert.equal(cfg.dockerReadOnly, true);
});

test("loadSandboxConfig accepts explicit host mode and rejects invalid modes or root users", () => {
  const hostCfg = loadSandboxConfig("/tmp/ws", { NANOGEM_EXECUTION_MODE: "host" });
  assert.equal(hostCfg.executionMode, "host");

  assert.throws(() => loadSandboxConfig("/tmp/ws", { NANOGEM_EXECUTION_MODE: "unsafe" }), /Invalid NANOGEM_EXECUTION_MODE/);
  assert.throws(() => loadSandboxConfig("/tmp/ws", { NANOGEM_DOCKER_USER: "0:0" }), /non-root/);
  assert.throws(() => loadSandboxConfig("/tmp/ws", { NANOGEM_DOCKER_USER: "root" }), /non-root/);
  assert.throws(() => loadSandboxConfig("/tmp/ws", { NANOGEM_DOCKER_USER: "1000:0" }), /non-root/);
});

test("buildDockerRunArgs enforces mount, non-root, cap-drop, no-new-privileges, limits, and network=none", () => {
  const cfg = loadSandboxConfig("/srv/nanogem/sandbox_workspace", {});
  const args = buildDockerRunArgs("ls -la", cfg, "nanogem-exec-test");

  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--init"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges:true"));
  assert.ok(args.includes("--read-only"));

  const volIdx = args.indexOf("-v");
  assert.notEqual(volIdx, -1);
  assert.equal(args[volIdx + 1], `${cfg.workspaceDir}:/workspace:rw`);
  // Only one -v workspace mount flag (only sandbox_workspace mounted)
  assert.equal(args.filter((a) => a === "-v").length, 1);

  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--cpus") + 1], "1.0");
  assert.equal(args[args.indexOf("--memory") + 1], "512m");
  assert.equal(args[args.indexOf("--memory-swap") + 1], "512m");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "64");

  const joined = args.join(" ");
  assert.equal(joined.includes("GEMINI_API_KEY"), false);
  assert.equal(joined.includes("NANOGEM_API_TOKEN"), false);
});

test("resolveSafeWorkspacePath blocks traversal and sibling prefix escapes", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-path-test-"));
  const wsDir = path.join(tmpRoot, "sandbox_workspace");
  const siblingDir = path.join(tmpRoot, "sandbox_workspace_evil");
  await fs.mkdir(wsDir, { recursive: true });
  await fs.mkdir(siblingDir, { recursive: true });
  await fs.writeFile(path.join(wsDir, "ok.txt"), "ok");
  await fs.writeFile(path.join(siblingDir, "secret.txt"), "secret");

  try {
    const ok = await resolveSafeWorkspacePath(wsDir, "ok.txt");
    assert.ok(ok && ok.endsWith(path.join("sandbox_workspace", "ok.txt")));

    const nestedNew = await resolveSafeWorkspacePath(wsDir, "sub/new.txt");
    assert.ok(nestedNew && nestedNew.endsWith(path.join("sandbox_workspace", "sub", "new.txt")));

    assert.equal(await resolveSafeWorkspacePath(wsDir, "../sandbox_workspace_evil/secret.txt"), null);
    assert.equal(await resolveSafeWorkspacePath(wsDir, "../../etc/passwd"), null);
    assert.equal(await resolveSafeWorkspacePath(wsDir, "bad\0path.txt"), null);
    assert.equal(await resolveSafeWorkspacePath(wsDir, "."), null);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveSafeWorkspacePath blocks direct, intermediate, and dangling symlink escapes", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-symlink-test-"));
  const wsDir = path.join(tmpRoot, "sandbox_workspace");
  const outsideDir = path.join(tmpRoot, "outside");
  await fs.mkdir(wsDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "top-secret");

  try {
    try {
      await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(wsDir, "leak.txt"));
      await fs.symlink(outsideDir, path.join(wsDir, "escape_dir"));
      await fs.symlink(path.join(outsideDir, "missing_dir"), path.join(wsDir, "dangling_dir"));
    } catch (err: any) {
      if (err?.code === "EPERM") {
        t.skip("Symlink creation requires elevated privileges on this host");
        return;
      }
      throw err;
    }

    assert.equal(await resolveSafeWorkspacePath(wsDir, "leak.txt"), null);
    assert.equal(await resolveSafeWorkspacePath(wsDir, "escape_dir/secret.txt"), null);
    assert.equal(await resolveSafeWorkspacePath(wsDir, "escape_dir/new.txt"), null);
    assert.equal(await resolveSafeWorkspacePath(wsDir, "dangling_dir"), null);
    assert.equal(await resolveSafeWorkspacePath(wsDir, "dangling_dir/nested/file.txt"), null);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("loadServerSecurityConfig blocks unauthenticated public binds", () => {
  const localCfg = loadServerSecurityConfig({});
  assert.equal(localCfg.host, "127.0.0.1");
  assert.equal(localCfg.port, 3000);
  assert.equal(localCfg.isPublicBind, false);

  assert.throws(
    () => loadServerSecurityConfig({ HOST: "0.0.0.0" }),
    /Refusing to bind NanoGem to non-loopback address/
  );
  assert.throws(
    () => loadServerSecurityConfig({ HOST: "0.0.0.0", NANOGEM_API_TOKEN: "short" }),
    /at least 16 characters/
  );

  const publicCfg = loadServerSecurityConfig({
    HOST: "0.0.0.0",
    NANOGEM_API_TOKEN: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(publicCfg.isPublicBind, true);
  assert.equal(publicCfg.authRequired, true);
  assert.equal(
    constantTimeTokenEqual(publicCfg.apiToken, "0123456789abcdef0123456789abcdef"),
    true
  );
  assert.equal(constantTimeTokenEqual(publicCfg.apiToken, "wrong-token"), false);
});

test("loadSandboxConfig accepts NANOGEM_SANDBOX_IMAGE, falls back to NANOGEM_DOCKER_IMAGE, and rejects invalid tokens", () => {
  const prebuilt = loadSandboxConfig("/tmp/ws", {
    NANOGEM_SANDBOX_IMAGE: "ghcr.io/jqcvsc/nanogem-sandbox:sha-0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(
    prebuilt.dockerImage,
    "ghcr.io/jqcvsc/nanogem-sandbox:sha-0123456789abcdef0123456789abcdef01234567"
  );

  const preferred = loadSandboxConfig("/tmp/ws", {
    NANOGEM_SANDBOX_IMAGE: "ghcr.io/jqcvsc/nanogem-sandbox:latest",
    NANOGEM_DOCKER_IMAGE: "legacy-alias:latest",
  });
  assert.equal(preferred.dockerImage, "ghcr.io/jqcvsc/nanogem-sandbox:latest");

  const legacyAlias = loadSandboxConfig("/tmp/ws", {
    NANOGEM_DOCKER_IMAGE: "custom-local:v1",
  });
  assert.equal(legacyAlias.dockerImage, "custom-local:v1");

  assert.throws(
    () => loadSandboxConfig("/tmp/ws", { NANOGEM_SANDBOX_IMAGE: "bad image" }),
    /Invalid NANOGEM_SANDBOX_IMAGE/
  );
  assert.throws(
    () => loadSandboxConfig("/tmp/ws", { NANOGEM_SANDBOX_IMAGE: "bad\0image" }),
    /Invalid NANOGEM_SANDBOX_IMAGE/
  );
});

test("executeSandboxCommand in docker mode fails closed when configured image or daemon is unavailable", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-docker-failclosed-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, {
      NANOGEM_EXECUTION_MODE: "docker",
      NANOGEM_SANDBOX_IMAGE: "ghcr.io/jqcvsc/nanogem-sandbox:sha-nonexistent",
    });
    const marker = path.join(tmpWs, "host-fallback-should-not-run.txt");
    const output = await executeSandboxCommand(
      `node -e "require('fs').writeFileSync('host-fallback-should-not-run.txt','pwned')"`,
      cfg
    );
    assert.match(output, /Sandbox Error:|Error executing command/);
    await assert.rejects(fs.access(marker));
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("executeSandboxCommand in explicit host mode strips secrets", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-host-exec-"));
  const prevKey = process.env.GEMINI_API_KEY;
  const prevToken = process.env.NANOGEM_API_TOKEN;
  process.env.GEMINI_API_KEY = "super-secret-gemini-key";
  process.env.NANOGEM_API_TOKEN = "super-secret-api-token";
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "host" });
    const output = await executeSandboxCommand(
      'node -e "console.log((process.env.GEMINI_API_KEY || \'STRIPPED\') + \':\' + (process.env.NANOGEM_API_TOKEN || \'STRIPPED\'))"',
      cfg
    );
    assert.equal(output.trim(), "STRIPPED:STRIPPED");
  } finally {
    if (prevKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevKey;
    }
    if (prevToken === undefined) {
      delete process.env.NANOGEM_API_TOKEN;
    } else {
      process.env.NANOGEM_API_TOKEN = prevToken;
    }
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

function createMockProbe(available: Set<ContainerRuntimeExecutable>, imagePresent = true): RuntimeProbeFn {
  return async (runtime, args) => {
    if (!available.has(runtime)) {
      return { ok: false, stdout: "", stderr: `${runtime} not installed` };
    }
    if (args[0] === "info") {
      return { ok: true, stdout: runtime === "docker" ? "27.0.0" : "5.2.0", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return imagePresent
        ? { ok: true, stdout: "sha256:abc", stderr: "" }
        : { ok: false, stdout: "", stderr: "No such image" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
}

function createCapturingSpawn(captured: Array<{ cmd: string; args: string[] }>) {
  return ((cmd: string, args: string[]) => {
    captured.push({ cmd, args: [...args] });
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(`ran-with:${cmd}`));
      child.emit("close", 0);
    });
    return child;
  }) as any;
}

test("NANOGEM_CONTAINER_RUNTIME rejects invalid values and defaults to auto", () => {
  const def = loadSandboxConfig("/tmp/ws", {});
  assert.equal(def.containerRuntime, "auto");
  assert.throws(
    () => loadSandboxConfig("/tmp/ws", { NANOGEM_CONTAINER_RUNTIME: "host" }),
    /Invalid NANOGEM_CONTAINER_RUNTIME/
  );
});

test("Runtime selection: 1. Docker selected, 2. Podman selected, 3. Auto->Docker, 4. Auto->Podman", async () => {
  const bothProbe = createMockProbe(new Set(["docker", "podman"]));
  const podmanOnlyProbe = createMockProbe(new Set(["podman"]));
  const dockerOnlyProbe = createMockProbe(new Set(["docker"]));

  // 1. Explicit docker selected
  const dockerCfg = loadSandboxConfig("/tmp/ws", { NANOGEM_CONTAINER_RUNTIME: "docker" });
  const r1 = await resolveContainerRuntime(dockerCfg, bothProbe);
  assert.equal(r1.selectedRuntime, "docker");

  // 2. Explicit podman selected (even when docker is available)
  const podmanCfg = loadSandboxConfig("/tmp/ws", { NANOGEM_CONTAINER_RUNTIME: "podman" });
  const r2 = await resolveContainerRuntime(podmanCfg, bothProbe);
  assert.equal(r2.selectedRuntime, "podman");

  // 3. Auto prefers docker when available
  const autoCfg = loadSandboxConfig("/tmp/ws", { NANOGEM_CONTAINER_RUNTIME: "auto" });
  const r3 = await resolveContainerRuntime(autoCfg, bothProbe);
  assert.equal(r3.selectedRuntime, "docker");
  const r3DockerOnly = await resolveContainerRuntime(autoCfg, dockerOnlyProbe);
  assert.equal(r3DockerOnly.selectedRuntime, "docker");

  // 4. Auto falls back to podman when docker is unavailable
  const r4 = await resolveContainerRuntime(autoCfg, podmanOnlyProbe);
  assert.equal(r4.selectedRuntime, "podman");
});

test("Runtime failures: 5. Explicit Docker fails, 6. Explicit Podman fails, 7. Neither available, 8. No host fallback", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-runtime-fail-"));
  const marker = path.join(tmpWs, "host-must-not-run.txt");
  try {
    const podmanOnlyProbe = createMockProbe(new Set(["podman"]));
    const dockerOnlyProbe = createMockProbe(new Set(["docker"]));
    const neitherProbe = createMockProbe(new Set());

    // 5. Explicit docker fails even when podman is available
    const dockerCfg = loadSandboxConfig(tmpWs, { NANOGEM_CONTAINER_RUNTIME: "docker" });
    const dockerStatus = await checkContainerRuntimeAvailability(dockerCfg, podmanOnlyProbe);
    assert.equal(dockerStatus.available, false);
    assert.equal(dockerStatus.selectedRuntime, null);
    assert.match(dockerStatus.error || "", /'docker' is unavailable/);

    // 6. Explicit podman fails even when docker is available
    const podmanCfg = loadSandboxConfig(tmpWs, { NANOGEM_CONTAINER_RUNTIME: "podman" });
    const podmanStatus = await checkContainerRuntimeAvailability(podmanCfg, dockerOnlyProbe);
    assert.equal(podmanStatus.available, false);
    assert.equal(podmanStatus.selectedRuntime, null);
    assert.match(podmanStatus.error || "", /'podman' is unavailable/);

    // 7. Neither runtime available in auto mode reports clear remediation
    const autoCfg = loadSandboxConfig(tmpWs, {
      NANOGEM_CONTAINER_RUNTIME: "auto",
      NANOGEM_SANDBOX_IMAGE: "ghcr.io/jqcvsc/nanogem-sandbox:sha-f8526c76498203b867960cd8bf244c04355f21a1",
    });
    const neitherStatus = await checkContainerRuntimeAvailability(autoCfg, neitherProbe);
    assert.equal(neitherStatus.available, false);
    assert.equal(neitherStatus.selectedRuntime, null);
    assert.match(neitherStatus.error || "", /Neither Docker nor Podman/);
    assert.match(neitherStatus.remediation || "", /Install Docker Desktop/);
    assert.match(neitherStatus.remediation || "", /Podman/);

    // 8. No silent host fallback when executing command without any runtime
    const execRes = await executeSandboxCommandDetailed(
      `node -e "require('fs').writeFileSync('host-must-not-run.txt','oops')"`,
      autoCfg,
      { probe: neitherProbe }
    );
    assert.equal(execRes.ok, false);
    assert.match(execRes.output, /Sandbox Error:/);
    await assert.rejects(fs.access(marker));
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("9. All hardened flags remain present when executing with either docker or podman", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-hardened-flags-"));
  try {
    for (const runtime of ["docker", "podman"] as const) {
      const captured: Array<{ cmd: string; args: string[] }> = [];
      const cfg = loadSandboxConfig(tmpWs, {
        NANOGEM_EXECUTION_MODE: "docker",
        NANOGEM_CONTAINER_RUNTIME: runtime,
        NANOGEM_SANDBOX_IMAGE: "ghcr.io/jqcvsc/nanogem-sandbox:sha-f8526c76498203b867960cd8bf244c04355f21a1",
      });
      const res = await executeSandboxCommandDetailed("echo hardened", cfg, {
        probe: createMockProbe(new Set([runtime])),
        spawnProcess: createCapturingSpawn(captured),
      });
      assert.equal(res.ok, true);
      assert.equal(res.output, `ran-with:${runtime}`);
      assert.equal(captured.length, 1);
      assert.equal(captured[0].cmd, runtime);

      const args = captured[0].args;
      const directArgs = buildContainerRunArgs("echo hardened", cfg, "test-container");
      assert.ok(args.includes("--rm"));
      assert.ok(args.includes("--init"));
      assert.ok(args.includes("--cap-drop=ALL"));
      assert.ok(args.includes("--security-opt=no-new-privileges:true"));
      assert.ok(args.includes("--read-only"));
      assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
      assert.equal(args[args.indexOf("--network") + 1], "none");
      assert.equal(args[args.indexOf("--cpus") + 1], "1.0");
      assert.equal(args[args.indexOf("--memory") + 1], "512m");
      assert.equal(args[args.indexOf("--memory-swap") + 1], "512m");
      assert.equal(args[args.indexOf("--pids-limit") + 1], "64");
      assert.ok(args.includes(`${cfg.workspaceDir}:/workspace:rw`));
      assert.equal(args.filter((a) => a === "--tmpfs").length, 3);
      assert.equal(directArgs.includes("--cap-drop=ALL"), true);
    }
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("regression: Podman args omit uid=1000/gid=1000 from mount options while preserving portable -v /workspace, --user 1000:1000, and --network none", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-podman-mount-"));
  try {
    const captured: Array<{ cmd: string; args: string[] }> = [];
    const cfg = loadSandboxConfig(tmpWs, {
      NANOGEM_EXECUTION_MODE: "docker",
      NANOGEM_CONTAINER_RUNTIME: "podman",
    });

    const res = await executeSandboxCommandDetailed("ls -la /workspace/", cfg, {
      probe: createMockProbe(new Set(["podman"])),
      spawnProcess: createCapturingSpawn(captured),
    });

    assert.equal(res.ok, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].cmd, "podman");

    const args = captured[0].args;
    const mountArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v" || args[i] === "--mount" || args[i] === "--tmpfs") {
        mountArgs.push(args[i + 1] || "");
      }
    }

    assert.ok(mountArgs.length >= 4);
    for (const mountVal of mountArgs) {
      assert.equal(mountVal.includes("uid=1000"), false, `Unexpected uid=1000 in mount option: ${mountVal}`);
      assert.equal(mountVal.includes("gid=1000"), false, `Unexpected gid=1000 in mount option: ${mountVal}`);
    }

    assert.equal(args[args.indexOf("-v") + 1], `${cfg.workspaceDir}:/workspace:rw`);
    assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.ok(args.includes("--cap-drop=ALL"));
    assert.ok(args.includes("--security-opt=no-new-privileges:true"));
    assert.ok(args.includes("--read-only"));
    assert.ok(mountArgs.some((m) => m.startsWith("/tmp:")));
    assert.ok(mountArgs.some((m) => m.startsWith("/run:")));
    assert.ok(mountArgs.some((m) => m.startsWith("/home/sandbox:")));
    assert.equal(args[args.indexOf("--cpus") + 1], "1.0");
    assert.equal(args[args.indexOf("--memory") + 1], "512m");
    assert.equal(args[args.indexOf("--pids-limit") + 1], "64");
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});
