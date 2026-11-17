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

test("executeSandboxCommand in explicit host mode strips secrets", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-host-exec-"));
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "super-secret-gemini-key";
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "host" });
    const output = await executeSandboxCommand(
      'node -e "console.log(process.env.GEMINI_API_KEY || \'STRIPPED\')"',
      cfg
    );
    assert.equal(output.trim(), "STRIPPED");
  } finally {
    if (prevKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevKey;
    }
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});
