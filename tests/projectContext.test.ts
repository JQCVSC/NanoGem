import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_PROJECT_CONTEXT_BYTES,
  appendCuratedProjectMemory,
  buildProjectSystemInstruction,
  isSensitiveFilePath,
  loadProjectInstructionsAndMemory,
  saveProjectContextFile,
} from "../src/agent/projectContext.ts";
import { runGeminiAgent, type GeminiGenerateContentClient } from "../src/agent/agentService.ts";
import { loadSandboxConfig } from "../src/server/sandboxRuntime.ts";

test("Different projects maintain independent GEMINI.md and MEMORY.md and construct isolated prompts", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-context-iso-"));
  const projA = path.join(tmpRoot, "proj-a");
  const projB = path.join(tmpRoot, "proj-b");
  await fs.mkdir(projA, { recursive: true });
  await fs.mkdir(projB, { recursive: true });

  try {
    await saveProjectContextFile(projA, "GEMINI.md", "Use TypeScript strict mode.");
    await saveProjectContextFile(projA, "MEMORY.md", "Project A uses Fastify.");
    await saveProjectContextFile(projB, "GEMINI.md", "Use Python 3.12 pytest.");

    const ctxA = await loadProjectInstructionsAndMemory(projA);
    const ctxB = await loadProjectInstructionsAndMemory(projB);

    assert.equal(ctxA.geminiMd, "Use TypeScript strict mode.");
    assert.equal(ctxA.memoryMd, "Project A uses Fastify.");
    assert.equal(ctxB.geminiMd, "Use Python 3.12 pytest.");
    assert.equal(ctxB.memoryMd, "");

    const promptA = buildProjectSystemInstruction({
      baseInstruction: "Base instruction",
      projectName: "Alpha",
      geminiMd: ctxA.geminiMd,
      memoryMd: ctxA.memoryMd,
    });
    const promptB = buildProjectSystemInstruction({
      baseInstruction: "Base instruction",
      projectName: "Beta",
      geminiMd: ctxB.geminiMd,
      memoryMd: ctxB.memoryMd,
    });

    assert.match(promptA, /PROJECT INSTRUCTIONS \(GEMINI\.md for "Alpha"\)/);
    assert.match(promptA, /Use TypeScript strict mode\./);
    assert.match(promptA, /PROJECT MEMORY \(MEMORY\.md for "Alpha"/);
    assert.match(promptA, /Project A uses Fastify\./);
    assert.match(promptA, /untrusted content/i);
    assert.match(promptA, /Google Gemini API/i);

    assert.match(promptB, /Use Python 3\.12 pytest\./);
    assert.equal(promptB.includes("Project A uses Fastify"), false);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Secret-like files and secret patterns are blocked or redacted and size limits are enforced", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-context-sec-"));
  try {
    assert.equal(isSensitiveFilePath(".env"), true);
    assert.equal(isSensitiveFilePath(".env.production"), true);
    assert.equal(isSensitiveFilePath(".env.example"), false);
    assert.equal(isSensitiveFilePath("config/id_rsa"), true);
    assert.equal(isSensitiveFilePath("certs/server.key"), true);

    await assert.rejects(
      () => appendCuratedProjectMemory(tmpWs, "GEMINI_API_KEY=secret", ".env"),
      /Refusing to import secret-like file/
    );

    const appended = await appendCuratedProjectMemory(
      tmpWs,
      "Note: GEMINI_API_KEY=AIzaSyDummySecretValue1234567890 should never be kept"
    );
    assert.equal(appended.redactedCount >= 1, true);
    assert.equal(appended.content.includes("AIzaSyDummySecretValue1234567890"), false);
    assert.match(appended.content, /\[REDACTED_SECRET\]/);

    const oversized = "x".repeat(MAX_PROJECT_CONTEXT_BYTES + 100);
    await assert.rejects(
      () => saveProjectContextFile(tmpWs, "GEMINI.md", oversized),
      /exceeds the/
    );
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("Agent cannot silently overwrite GEMINI.md or MEMORY.md via write_local_file", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-context-protect-"));
  try {
    await saveProjectContextFile(tmpWs, "GEMINI.md", "Original rules");
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "host" });
    let turn = 0;
    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent() {
          turn++;
          if (turn === 1) {
            return {
              candidates: [{ content: { role: "model", parts: [] } }],
              functionCalls: [
                {
                  name: "write_local_file",
                  args: { file_path: "GEMINI.md", content: "Hijacked rules" },
                },
                {
                  name: "write_local_file",
                  args: { file_path: "MEMORY.md", content: "Silent memory rewrite" },
                },
              ],
            };
          }
          return {
            text: "Proposed update instead.",
            candidates: [{ content: { role: "model", parts: [{ text: "Proposed update instead." }] } }],
            functionCalls: [],
          };
        },
      },
    };

    const res = await runGeminiAgent(
      { message: "Rewrite rules", sandboxConfig: cfg, protectContextFiles: true },
      { client: mockClient }
    );
    assert.equal(res.text, "Proposed update instead.");
    assert.equal(await fs.readFile(path.join(tmpWs, "GEMINI.md"), "utf8"), "Original rules");
    await assert.rejects(fs.access(path.join(tmpWs, "MEMORY.md")));
    assert.ok(
      res.events.some(
        (e) =>
          e.type === "tool_result" &&
          e.success === false &&
          e.output.includes("Protected Context File")
      )
    );
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});
