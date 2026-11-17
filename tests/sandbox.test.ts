import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDockerRunArgs,
  executeSandboxCommand,
  loadSandboxConfig,
  resolveSafeWorkspacePath,
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

  const mountIdx = args.indexOf("--mount");
  assert.notEqual(mountIdx, -1);
  assert.equal(args[mountIdx + 1], `type=bind,source=${cfg.workspaceDir},target=/workspace`);
  // Only one --mount flag (only sandbox_workspace mounted)
  assert.equal(args.filter((a) => a === "--mount").length, 1);

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
