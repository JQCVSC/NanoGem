import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_WORKFLOW_FILE_BYTES,
  MAX_WORKFLOW_TOTAL_BYTES,
  WORKFLOW_DATA_HANDLING_NOTICE,
  WORKFLOW_TEMPLATES,
  prepareWorkflowPrompt,
} from "../src/workflows/projectWorkflows.ts";

test("Workflow templates define clear output formats and honest data-handling notice", () => {
  assert.equal(WORKFLOW_TEMPLATES.length, 4);
  for (const tpl of WORKFLOW_TEMPLATES) {
    assert.ok(tpl.title);
    assert.ok(tpl.outputFormat);
    assert.ok(tpl.allowedExtensions.length > 0);
  }
  assert.match(WORKFLOW_DATA_HANDLING_NOTICE, /Google Gemini API/i);
  assert.equal(
    /data never leaves/i.test(WORKFLOW_DATA_HANDLING_NOTICE),
    false
  );
});

test("prepareWorkflowPrompt enforces confirmation, file types, sensitive-file blocks, path safety, and size limits", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-workflows-"));
  try {
    await fs.writeFile(path.join(tmpWs, "data.csv"), "name,score\nalice,10\nbob,20\n");
    await fs.writeFile(path.join(tmpWs, ".env"), "GEMINI_API_KEY=secret\n");
    await fs.writeFile(path.join(tmpWs, "archive.zip"), "binary");
    await fs.writeFile(
      path.join(tmpWs, "huge.json"),
      "x".repeat(MAX_WORKFLOW_FILE_BYTES + 10)
    );
    await fs.writeFile(
      path.join(tmpWs, "part1.json"),
      "a".repeat(MAX_WORKFLOW_FILE_BYTES - 10)
    );
    await fs.writeFile(
      path.join(tmpWs, "part2.json"),
      "b".repeat(MAX_WORKFLOW_FILE_BYTES - 10)
    );
    await fs.writeFile(
      path.join(tmpWs, "part3.json"),
      "c".repeat(200)
    );

    // Requires explicit confirmation
    await assert.rejects(
      () =>
        prepareWorkflowPrompt({
          workspaceDir: tmpWs,
          templateId: "data_analysis",
          goal: "Analyze data.csv",
          selectedFiles: ["data.csv"],
          confirmSendToGemini: false,
        }),
      /Explicit confirmation/
    );

    // Rejects sensitive .env file
    await assert.rejects(
      () =>
        prepareWorkflowPrompt({
          workspaceDir: tmpWs,
          templateId: "technical_research",
          goal: "Inspect",
          selectedFiles: [".env"],
          confirmSendToGemini: true,
        }),
      /Sensitive file/
    );

    // Rejects unsupported file extension
    await assert.rejects(
      () =>
        prepareWorkflowPrompt({
          workspaceDir: tmpWs,
          templateId: "data_analysis",
          goal: "Inspect",
          selectedFiles: ["archive.zip"],
          confirmSendToGemini: true,
        }),
      /Unsupported file type/
    );

    // Rejects traversal outside workspace
    await assert.rejects(
      () =>
        prepareWorkflowPrompt({
          workspaceDir: tmpWs,
          templateId: "technical_research",
          goal: "Inspect",
          selectedFiles: ["../outside.md"],
          confirmSendToGemini: true,
        }),
      /Security Error/
    );

    // Rejects oversized single file
    await assert.rejects(
      () =>
        prepareWorkflowPrompt({
          workspaceDir: tmpWs,
          templateId: "data_analysis",
          goal: "Inspect",
          selectedFiles: ["huge.json"],
          confirmSendToGemini: true,
        }),
      /per-file limit/
    );

    // Rejects exceeding total limit
    assert.ok(
      (MAX_WORKFLOW_FILE_BYTES - 10) * 2 + 200 > MAX_WORKFLOW_TOTAL_BYTES
    );
    await assert.rejects(
      () =>
        prepareWorkflowPrompt({
          workspaceDir: tmpWs,
          templateId: "data_analysis",
          goal: "Inspect",
          selectedFiles: ["part1.json", "part2.json", "part3.json"],
          confirmSendToGemini: true,
        }),
      /Total selected file size exceeds/
    );

    // Succeeds for allowed file with confirmation
    const prepared = await prepareWorkflowPrompt({
      workspaceDir: tmpWs,
      templateId: "data_analysis",
      goal: "Compute average score",
      selectedFiles: ["data.csv"],
      confirmSendToGemini: true,
    });
    assert.equal(prepared.includedFiles.length, 1);
    assert.match(prepared.prompt, /CSV \/ JSON Data Analysis/);
    assert.match(prepared.prompt, /alice,10/);
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});
