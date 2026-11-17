import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openNanoGemDatabase } from "../src/storage/database.ts";
import { ProjectStore, resolveApprovedProjectWorkspace } from "../src/storage/projectStore.ts";
import { SessionStore } from "../src/storage/sessionStore.ts";

test("SQLite storage persists projects, sessions, messages, and execution events across restarts", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-storage-persist-"));
  const dbPath = path.join(tmpRoot, "nanogem.db");
  const projectsRoot = path.join(tmpRoot, "projects");
  const defaultWs = path.join(tmpRoot, "sandbox_workspace");

  try {
    // First boot
    const db1 = openNanoGemDatabase(dbPath);
    const projectStore1 = new ProjectStore(db1, projectsRoot);
    const sessionStore1 = new SessionStore(db1);

    const defProj = projectStore1.ensureDefaultProject(defaultWs);
    assert.equal(defProj.id, "default");
    const appProj = projectStore1.createProject({ name: "My App" });
    const session = sessionStore1.createSession({
      projectId: appProj.id,
      title: "Feature Build",
    });

    sessionStore1.appendMessage({
      sessionId: session.id,
      projectId: appProj.id,
      role: "user",
      content: "Create app.js",
    });
    sessionStore1.appendMessage({
      sessionId: session.id,
      projectId: appProj.id,
      role: "assistant",
      content: "Created app.js",
      executionSteps: [
        {
          type: "tool_call",
          toolName: "write_local_file",
          args: { file_path: "app.js", content: "console.log(1)" },
          output: "Success",
        },
      ],
    });
    sessionStore1.appendExecutionEvents(session.id, appProj.id, [
      {
        type: "tool_call_requested",
        turn: 1,
        toolName: "write_local_file",
        args: { file_path: "app.js" },
        timestamp: new Date().toISOString(),
      },
      {
        type: "final_response",
        turn: 1,
        text: "Created app.js",
        maxTurnsReached: false,
        timestamp: new Date().toISOString(),
      },
    ]);
    db1.close();

    // Second boot (simulated server restart)
    const db2 = openNanoGemDatabase(dbPath);
    const projectStore2 = new ProjectStore(db2, projectsRoot);
    const sessionStore2 = new SessionStore(db2);

    const projects = projectStore2.listProjects();
    assert.equal(projects.length, 2);
    assert.ok(projects.some((p) => p.id === appProj.id && p.name === "My App"));

    const resumed = sessionStore2.getSessionDetails(session.id, appProj.id);
    assert.ok(resumed);
    assert.equal(resumed.session.title, "Feature Build");
    assert.equal(resumed.messages.length, 2);
    assert.equal(resumed.messages[1].executionSteps.length, 1);
    assert.equal(resumed.events.length, 2);
    assert.equal(resumed.events[0].eventType, "tool_call_requested");
    assert.equal(resumed.events[1].eventType, "final_response");
    db2.close();
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("ProjectStore validates project paths against approved root and enforces cross-project isolation", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-storage-iso-"));
  const dbPath = path.join(tmpRoot, "nanogem.db");
  const projectsRoot = path.join(tmpRoot, "approved_projects");
  const outsideDir = path.join(tmpRoot, "outside");
  await fs.mkdir(projectsRoot, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  try {
    assert.throws(
      () => resolveApprovedProjectWorkspace(projectsRoot, "../outside"),
      /Security Error/
    );
    assert.throws(
      () => resolveApprovedProjectWorkspace(projectsRoot, outsideDir),
      /Security Error/
    );
    assert.throws(
      () => resolveApprovedProjectWorkspace(projectsRoot, projectsRoot),
      /Security Error/
    );

    const db = openNanoGemDatabase(dbPath);
    const projectStore = new ProjectStore(db, projectsRoot);
    const sessionStore = new SessionStore(db);

    const p1 = projectStore.createProject({ name: "Alpha", workspacePath: "alpha" });
    const p2 = projectStore.createProject({ name: "Beta", workspacePath: "beta" });

    assert.throws(
      () => projectStore.createProject({ name: "Overlap", workspacePath: "alpha/sub" }),
      /conflicts with existing project/
    );

    const s1 = sessionStore.createSession({ projectId: p1.id, title: "Alpha Session" });

    // Cross-project session read or write must be rejected
    assert.throws(
      () => sessionStore.getSessionDetails(s1.id, p2.id),
      /Security Error/
    );
    assert.throws(
      () =>
        sessionStore.appendMessage({
          sessionId: s1.id,
          projectId: p2.id,
          role: "user",
          content: "Cross-project injection",
        }),
      /Security Error/
    );

    // Workspace file isolation
    const alphaFile = await projectStore.resolveProjectFile(p1.id, "secret.txt");
    assert.ok(alphaFile);
    await fs.writeFile(alphaFile, "alpha-only");
    assert.equal(await projectStore.resolveProjectFile(p1.id, "../beta/secret.txt"), null);
    assert.equal(await projectStore.resolveProjectFile(p2.id, "../alpha/secret.txt"), null);

    db.close();
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
