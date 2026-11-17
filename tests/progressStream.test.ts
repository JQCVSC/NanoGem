import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runGeminiAgent,
  type GeminiGenerateContentClient,
} from "../src/agent/agentService.ts";
import {
  AgentProgressStream,
  sanitizeCommandSummary,
  type ProgressEvent,
} from "../src/agent/progressStream.ts";
import { loadSandboxConfig } from "../src/server/sandboxRuntime.ts";

test("sanitizeCommandSummary strips secrets and truncates verbose arguments", () => {
  const raw =
    'GEMINI_API_KEY=AIzaSySuperSecretKey1234567890 curl --token=tok_secret -H "Authorization: Bearer my.jwt.token" https://example.com/' +
    "a".repeat(100);
  const sanitized = sanitizeCommandSummary(raw);
  assert.equal(sanitized.includes("AIzaSySuperSecretKey1234567890"), false);
  assert.equal(sanitized.includes("tok_secret"), false);
  assert.equal(sanitized.includes("my.jwt.token"), false);
  assert.ok(sanitized.length <= 72);
});

test("AgentProgressStream preserves stage ordering across multi-turn tool execution", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-progress-ok-"));
  try {
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
                { name: "execute_system_command", args: { command: "echo step1" } },
              ],
            };
          }
          return {
            text: "All steps complete.",
            candidates: [{ content: { role: "model", parts: [{ text: "All steps complete." }] } }],
            functionCalls: [],
          };
        },
      },
    };

    const stream = new AgentProgressStream();
    const observed: ProgressEvent[] = [];
    stream.subscribe((ev) => {
      observed.push(ev);
    });

    const result = await runGeminiAgent(
      {
        message: "Run echo step1",
        sandboxConfig: cfg,
        onPhase: (phase, t) => stream.handlePhase(phase, t),
        onEvent: (event) => stream.handleAgentEvent(event),
      },
      { client: mockClient }
    );

    assert.equal(result.text, "All steps complete.");
    assert.deepEqual(
      observed.map((e) => e.stage),
      [
        "analyzing_request",
        "calling_gemini",
        "running_command",
        "command_completed",
        "reviewing_changes",
        "finished",
      ]
    );
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("AgentProgressStream emits command_failed without leaking secrets on failed sandbox commands", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-progress-fail-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, {
      NANOGEM_EXECUTION_MODE: "docker",
      NANOGEM_SANDBOX_IMAGE: "ghcr.io/jqcvsc/nanogem-sandbox:sha-nonexistent",
    });

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
                  name: "execute_system_command",
                  args: { command: "API_KEY=secret123 false" },
                },
              ],
            };
          }
          return {
            text: "Recovered after failure.",
            candidates: [{ content: { role: "model", parts: [{ text: "Recovered after failure." }] } }],
            functionCalls: [],
          };
        },
      },
    };

    const stream = new AgentProgressStream();
    await runGeminiAgent(
      {
        message: "Run failing command",
        sandboxConfig: cfg,
        onPhase: (phase, t) => stream.handlePhase(phase, t),
        onEvent: (event) => stream.handleAgentEvent(event),
      },
      { client: mockClient }
    );

    const events = stream.getEvents();
    assert.deepEqual(
      events.map((e) => e.stage),
      [
        "analyzing_request",
        "calling_gemini",
        "running_command",
        "command_failed",
        "reviewing_changes",
        "finished",
      ]
    );
    const failedEvent = events.find((e) => e.stage === "command_failed");
    assert.ok(failedEvent?.detail);
    assert.equal(failedEvent.detail.includes("secret123"), false);
    assert.match(failedEvent.detail, /API_KEY=\[REDACTED\]/);
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});
