import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isConfiguredGeminiApiKey,
  runGeminiAgent,
  type AgentEvent,
  type GeminiGenerateContentClient,
} from "../src/agent/agentService.ts";
import { loadSandboxConfig } from "../src/server/sandboxRuntime.ts";

test("isConfiguredGeminiApiKey rejects empty and placeholder keys", () => {
  assert.equal(isConfiguredGeminiApiKey(undefined), false);
  assert.equal(isConfiguredGeminiApiKey(""), false);
  assert.equal(isConfiguredGeminiApiKey("MY_GEMINI_API_KEY"), false);
  assert.equal(isConfiguredGeminiApiKey("your_gemini_api_key_here"), false);
  assert.equal(isConfiguredGeminiApiKey("AIzaSyRealLookingKey12345"), true);
});

test("runGeminiAgent handles a successful direct response with history and system instruction", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-agent-ok-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "docker" });
    let capturedParams: any = null;
    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent(params) {
          capturedParams = params;
          return {
            text: "Hello from Gemini!",
            candidates: [{ content: { role: "model", parts: [{ text: "Hello from Gemini!" }] } }],
            functionCalls: [],
          };
        },
      },
    };

    const streamedEvents: AgentEvent[] = [];
    const result = await runGeminiAgent(
      {
        message: "Say hello",
        history: [{ role: "user", content: "Previous context" }],
        model: "gemini-3.6-flash",
        systemInstruction: "Custom system instruction",
        sandboxConfig: cfg,
        onEvent: (event) => {
          streamedEvents.push(event);
        },
      },
      { client: mockClient }
    );

    assert.equal(result.text, "Hello from Gemini!");
    assert.equal(result.turns, 1);
    assert.equal(result.maxTurnsReached, false);
    assert.equal(result.executionSteps.length, 1);
    assert.equal(result.executionSteps[0].type, "text_response");
    assert.deepEqual(
      streamedEvents.map((e) => e.type),
      ["assistant_text", "final_response"]
    );
    assert.equal(capturedParams.config.systemInstruction, "Custom system instruction");
    assert.equal(capturedParams.contents.length, 2);
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("runGeminiAgent executes write_local_file and execute_system_command through sandbox runtime", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-agent-tool-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "host" });
    let callCount = 0;
    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent() {
          callCount++;
          if (callCount === 1) {
            return {
              candidates: [{ content: { role: "model", parts: [{ text: "Running tools" }] } }],
              functionCalls: [
                {
                  name: "write_local_file",
                  args: { file_path: "hello.txt", content: "hello-sandbox" },
                },
                {
                  name: "execute_system_command",
                  args: { command: 'node -e "console.log(require(\'fs\').readFileSync(\'hello.txt\',\'utf8\'))"' },
                },
              ],
            };
          }
          return {
            text: "Created and verified hello.txt.",
            candidates: [{ content: { role: "model", parts: [{ text: "Created and verified hello.txt." }] } }],
            functionCalls: [],
          };
        },
      },
    };

    const result = await runGeminiAgent(
      {
        message: "Create hello.txt and print it",
        sandboxConfig: cfg,
      },
      { client: mockClient }
    );

    assert.equal(result.text, "Created and verified hello.txt.");
    assert.equal(result.turns, 2);
    assert.equal(result.maxTurnsReached, false);
    assert.equal(await fs.readFile(path.join(tmpWs, "hello.txt"), "utf8"), "hello-sandbox");
    assert.deepEqual(
      result.events.map((e) => e.type),
      [
        "tool_call_requested",
        "tool_result",
        "tool_call_requested",
        "command_started",
        "command_completed",
        "tool_result",
        "assistant_text",
        "final_response",
      ]
    );
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("runGeminiAgent emits failure events for rejected file paths, failed commands, and API errors", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-agent-fail-"));
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
                  name: "write_local_file",
                  args: { file_path: "../escape.txt", content: "blocked" },
                },
                {
                  name: "execute_system_command",
                  args: { command: "echo fail-closed" },
                },
              ],
            };
          }
          return {
            text: "Handled tool failures.",
            candidates: [{ content: { role: "model", parts: [{ text: "Handled tool failures." }] } }],
            functionCalls: [],
          };
        },
      },
    };

    const result = await runGeminiAgent(
      { message: "Try unsafe write and command", sandboxConfig: cfg },
      { client: mockClient }
    );

    assert.equal(result.text, "Handled tool failures.");
    const eventTypes = result.events.map((e) => e.type);
    assert.ok(eventTypes.includes("command_started"));
    assert.ok(eventTypes.includes("command_failed"));
    const toolResults = result.events.filter((e) => e.type === "tool_result");
    assert.equal(toolResults.length, 2);
    assert.equal(toolResults[0].success, false);
    assert.match(toolResults[0].output, /Security Error/);
    assert.equal(toolResults[1].success, false);

    // API error retries transient 503s, emits execution_error, and propagates structured error
    const failingEvents: AgentEvent[] = [];
    const errorClient: GeminiGenerateContentClient = {
      models: {
        async generateContent() {
          throw new Error("Gemini upstream 503");
        },
      },
    };
    await assert.rejects(
      () =>
        runGeminiAgent(
          {
            message: "Trigger upstream error",
            sandboxConfig: cfg,
            onEvent: (ev) => {
              failingEvents.push(ev);
            },
          },
          { client: errorClient, sleep: async () => {} }
        ),
      /Gemini is temporarily unavailable because the selected model is under high demand\./
    );
    assert.equal(failingEvents.at(-1)?.type, "execution_error");
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("runGeminiAgent terminates cleanly when maxTurns is reached", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-agent-maxturns-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "host" });
    let calls = 0;
    const infiniteToolClient: GeminiGenerateContentClient = {
      models: {
        async generateContent() {
          calls++;
          return {
            candidates: [{ content: { role: "model", parts: [] } }],
            functionCalls: [
              {
                name: "execute_system_command",
                args: { command: "echo loop" },
              },
            ],
          };
        },
      },
    };

    const result = await runGeminiAgent(
      {
        message: "Loop forever",
        maxTurns: 2,
        sandboxConfig: cfg,
      },
      { client: infiniteToolClient }
    );

    assert.equal(calls, 2);
    assert.equal(result.turns, 2);
    assert.equal(result.maxTurnsReached, true);
    assert.match(result.text, /maximum turn limit \(2\)/i);
    assert.ok(result.events.some((e) => e.type === "execution_error"));
    const finalEv = result.events.find((e) => e.type === "final_response");
    assert.ok(finalEv && finalEv.type === "final_response" && finalEv.maxTurnsReached);
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});
