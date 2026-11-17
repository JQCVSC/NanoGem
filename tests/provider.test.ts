import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { GeminiGenerateContentClient } from "../src/agent/agentService.ts";
import { GeminiAgentProvider, resolveAgentProvider } from "../src/agent/provider.ts";
import { loadSandboxConfig } from "../src/server/sandboxRuntime.ts";

test("resolveAgentProvider defaults to Gemini, exposes typed capabilities, and rejects unsupported providers", () => {
  const defaultProvider = resolveAgentProvider(undefined, {}, {});
  assert.equal(defaultProvider.id, "gemini");
  assert.equal(defaultProvider.displayName, "Google Gemini");
  assert.equal(defaultProvider.capabilities.supportsToolCalling, true);
  assert.equal(defaultProvider.capabilities.gemini?.defaultModel, "gemini-3.6-flash");
  assert.ok(defaultProvider instanceof GeminiAgentProvider);

  const explicitProvider = resolveAgentProvider("GEMINI", {}, {});
  assert.equal(explicitProvider.id, "gemini");

  assert.throws(
    () => resolveAgentProvider("openai", {}, {}),
    /Unsupported agent provider "openai"/
  );
  assert.throws(
    () => resolveAgentProvider(undefined, {}, { NANOGEM_PROVIDER: "claude" }),
    /Unsupported agent provider "claude"/
  );
  assert.throws(
    () => resolveAgentProvider(undefined, {}, { NANOGEM_PROVIDER: "ollama" }),
    /Only "gemini" is enabled/
  );
});

test("GeminiAgentProvider checks API key configuration and executes agent runs", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-provider-"));
  try {
    const unconfigured = resolveAgentProvider("gemini", {}, {});
    assert.equal(unconfigured.isConfigured({}), false);
    assert.equal(unconfigured.isConfigured({ GEMINI_API_KEY: "MY_GEMINI_API_KEY" }), false);
    assert.equal(unconfigured.isConfigured({ GEMINI_API_KEY: "AIzaSyValidKey1234567890" }), true);

    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent() {
          return {
            text: "Provider abstraction works.",
            candidates: [{ content: { role: "model", parts: [{ text: "Provider abstraction works." }] } }],
            functionCalls: [],
          };
        },
      },
    };
    const configured = resolveAgentProvider("gemini", { client: mockClient });
    assert.equal(configured.isConfigured({}), true);

    const res = await configured.run({
      message: "Ping",
      sandboxConfig: loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "docker" }),
    });
    assert.equal(res.text, "Provider abstraction works.");
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});
