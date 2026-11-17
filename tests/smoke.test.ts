import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SERVER_BUNDLE = path.resolve(process.cwd(), "dist", "server.cjs");

async function waitForHealth(url: string): Promise<Response> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // Server still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopServerProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore
      }
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

test("built server refuses non-loopback bind without NANOGEM_API_TOKEN", () => {
  const result = spawnSync("node", [SERVER_BUNDLE], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "3198",
      NANOGEM_API_TOKEN: "",
    },
    encoding: "utf-8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to bind NanoGem to non-loopback address/);
});

test("built server enforces auth and docker default, and supports explicit host mode", async () => {
  const tmpStorage = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-smoke-store-"));
  const dbPath = path.join(tmpStorage, "nanogem.db");
  const projectsRoot = path.join(tmpStorage, "projects");

  const token = "smoke-test-token-1234567890";
  const srvDocker = spawn("node", [SERVER_BUNDLE], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "3199",
      NANOGEM_API_TOKEN: token,
      GEMINI_API_KEY: "MY_GEMINI_API_KEY",
      NANOGEM_DB_PATH: dbPath,
      NANOGEM_PROJECTS_ROOT: projectsRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const healthRes = await waitForHealth("http://127.0.0.1:3199/api/health");
    const health = await healthRes.json();
    assert.equal(health.status, "ok");
    assert.equal(health.executionMode, "docker");
    assert.equal(health.authRequired, true);

    const htmlRes = await fetch("http://127.0.0.1:3199/");
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /<!doctype html>/i);

    const unauthRes = await fetch("http://127.0.0.1:3199/api/workspace/files");
    assert.equal(unauthRes.status, 401);

    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const filesRes = await fetch("http://127.0.0.1:3199/api/workspace/files", {
      headers: authHeaders,
    });
    assert.equal(filesRes.status, 200);
    const filesData = await filesRes.json();
    assert.ok(Array.isArray(filesData.files));
    assert.ok(filesData.files.some((f: any) => f.name === "README.md"));

    const statusRes = await fetch("http://127.0.0.1:3199/api/runtime/status", {
      headers: authHeaders,
    });
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.executionMode, "docker");
    assert.equal(statusData.docker.network, "none");
    assert.equal(statusData.docker.user, "1000:1000");

    const termRes = await fetch("http://127.0.0.1:3199/api/workspace/terminal", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ command: "echo should-not-run-on-host" }),
    });
    assert.equal(termRes.status, 200);
    const termData = await termRes.json();
    if (!statusData.docker.available) {
      assert.match(termData.output, /Sandbox Error:/);
    }

    // Regression checks from Prompt 1 security & correctness audit
    const traversalPost = await fetch("http://127.0.0.1:3199/api/workspace/file", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ path: "../outside.txt", content: "nope" }),
    });
    assert.equal(traversalPost.status, 403);

    const invalidContentPost = await fetch("http://127.0.0.1:3199/api/workspace/file", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ path: "ok.txt", content: { invalid: true } }),
    });
    assert.equal(invalidContentPost.status, 400);

    const missingGet = await fetch("http://127.0.0.1:3199/api/workspace/file?path=does-not-exist.txt", {
      headers: authHeaders,
    });
    assert.equal(missingGet.status, 404);

    const invalidTerm = await fetch("http://127.0.0.1:3199/api/workspace/terminal", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ command: "   " }),
    });
    assert.equal(invalidTerm.status, 400);

    const placeholderChat = await fetch("http://127.0.0.1:3199/api/agent/chat", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(placeholderChat.status, 503);

    const unauthUnknownApi = await fetch("http://127.0.0.1:3199/api/nonexistent");
    assert.equal(unauthUnknownApi.status, 401);

    const authUnknownApi = await fetch("http://127.0.0.1:3199/api/nonexistent", {
      headers: authHeaders,
    });
    assert.equal(authUnknownApi.status, 404);
    const unknownApiBody = await authUnknownApi.json();
    assert.equal(unknownApiBody.error, "API route not found");

    // Stage 3: project creation, session creation, cross-project isolation
    const createProjRes = await fetch("http://127.0.0.1:3199/api/projects", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "Smoke Project", workspacePath: "smoke-proj" }),
    });
    assert.equal(createProjRes.status, 201);
    const createdProj = await createProjRes.json();
    assert.ok(createdProj.project.id);

    const badProjRes = await fetch("http://127.0.0.1:3199/api/projects", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "Escape", workspacePath: "../escape" }),
    });
    assert.equal(badProjRes.status, 400);

    const createSessRes = await fetch("http://127.0.0.1:3199/api/sessions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ projectId: createdProj.project.id, title: "Smoke Session" }),
    });
    assert.equal(createSessRes.status, 201);
    const createdSess = await createSessRes.json();

    const crossProjectSess = await fetch(
      `http://127.0.0.1:3199/api/sessions/${createdSess.session.id}?projectId=default`,
      { headers: authHeaders }
    );
    assert.equal(crossProjectSess.status, 403);
  } finally {
    await stopServerProcess(srvDocker);
  }

  const srvHost = spawn("node", [SERVER_BUNDLE], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "3200",
      NANOGEM_EXECUTION_MODE: "host",
      NANOGEM_API_TOKEN: "",
      NANOGEM_DB_PATH: dbPath,
      NANOGEM_PROJECTS_ROOT: projectsRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const h2 = await (await waitForHealth("http://127.0.0.1:3200/api/health")).json();
    assert.equal(h2.executionMode, "host");

    // Verify projects and sessions persisted across server restart
    const persistedProjects = await (await fetch("http://127.0.0.1:3200/api/projects")).json();
    assert.ok(persistedProjects.projects.some((p: any) => p.name === "Smoke Project"));

    const t2Res = await fetch("http://127.0.0.1:3200/api/workspace/terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: 'node -e "console.log(String.fromCharCode(115,109,111,107,101))"',
      }),
    });
    assert.equal(t2Res.status, 200);
    const t2 = await t2Res.json();
    assert.equal(t2.output, "smoke");
  } finally {
    await stopServerProcess(srvHost);
    await fs.rm(tmpStorage, { recursive: true, force: true });
  }
});
