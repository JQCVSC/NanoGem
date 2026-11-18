import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import esbuild from "esbuild";
import {
  DEFAULT_FALLBACK_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL,
  runGeminiAgent,
  type GeminiGenerateContentClient,
} from "../src/agent/agentService.ts";
import {
  GeminiAgentError,
  MAX_GEMINI_RETRIES,
  classifyGeminiError,
  defaultGeminiRetryLogger,
  executeWithGeminiRetry,
  toStructuredAgentErrorPayload,
  type GeminiRetryLogEntry,
} from "../src/agent/geminiErrors.ts";
import { loadSandboxConfig } from "../src/server/sandboxRuntime.ts";
import type { ProjectSummary, RuntimeStatus, SessionSummary } from "../src/types.ts";

test("runGeminiAgent retries transient 503 high-demand error and succeeds on recovery with redacted logs", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-retry-ok-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "docker" });
    let attempts = 0;
    const sleeps: number[] = [];
    const logs: GeminiRetryLogEntry[] = [];
    let tick = 1000;

    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent() {
          attempts++;
          tick += 125;
          if (attempts === 1) {
            throw Object.assign(
              new Error(
                JSON.stringify({
                  error: {
                    code: 503,
                    message:
                      "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
                    status: "UNAVAILABLE",
                  },
                })
              ),
              { status: 503 }
            );
          }
          return {
            text: "Recovered after transient 503.",
            candidates: [
              { content: { role: "model", parts: [{ text: "Recovered after transient 503." }] } },
            ],
            functionCalls: [],
          };
        },
      },
    };

    const result = await runGeminiAgent(
      {
        message: "Ping Gemini",
        model: "gemini-3.6-flash",
        sandboxConfig: cfg,
      },
      {
        client: mockClient,
        retryDelaysMs: [1000, 3000],
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: () => tick,
        logger: (entry) => logs.push(entry),
      }
    );

    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [1000]);
    assert.equal(result.text, "Recovered after transient 503.");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 503);
    assert.equal(logs[0].model, "gemini-3.6-flash");
    assert.equal(logs[0].attempt, 1);
    assert.equal(logs[0].maxAttempts, 3);
    assert.equal(logs[0].nextDelayMs, 1000);
    assert.ok(logs[0].elapsedMs >= 125);
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("runGeminiAgent caps retries at 2 (1s then 3s) and throws exact structured 503 error", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-retry-503-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "docker" });
    let attempts = 0;
    const sleeps: number[] = [];
    const logs: GeminiRetryLogEntry[] = [];

    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent() {
          attempts++;
          throw Object.assign(
            new Error(
              "503 UNAVAILABLE: This model is currently experiencing high demand. Spikes in demand are usually temporary."
            ),
            { status: 503 }
          );
        },
      },
    };

    let caught: unknown;
    try {
      await runGeminiAgent(
        {
          message: "Keep failing",
          model: "gemini-3.6-flash",
          fallbackModel: "",
          sandboxConfig: cfg,
        },
        {
          client: mockClient,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          logger: (entry) => logs.push(entry),
        }
      );
      assert.fail("Expected runGeminiAgent to throw after exhausting retries");
    } catch (err) {
      caught = err;
    }

    assert.equal(MAX_GEMINI_RETRIES, 2);
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [1000, 3000]);
    assert.equal(logs.length, 3);
    assert.equal(logs[2].attempt, 3);
    assert.equal(logs[2].nextDelayMs, undefined);

    assert.ok(caught instanceof GeminiAgentError);
    assert.deepEqual(toStructuredAgentErrorPayload(caught), {
      error:
        "Gemini is temporarily unavailable because the selected model is under high demand. Please try again shortly.",
      code: "GEMINI_TEMPORARILY_UNAVAILABLE",
      retryable: true,
      status: 503,
    });
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("429, 500, 502, and 504 transient errors are detected and bounded at 2 retries", async () => {
  for (const statusCode of [429, 500, 502, 504]) {
    let attempts = 0;
    const sleeps: number[] = [];

    await assert.rejects(
      () =>
        executeWithGeminiRetry(
          async () => {
            attempts++;
            throw Object.assign(new Error(`Upstream HTTP ${statusCode}`), { status: statusCode });
          },
          {
            model: "gemini-3.6-flash",
            // Deliberately pass extra delays to verify MAX_GEMINI_RETRIES hard cap
            retryDelaysMs: [1000, 3000, 9000, 27000],
            sleep: async (ms) => {
              sleeps.push(ms);
            },
            logger: () => {},
          }
        ),
      (err: unknown) => {
        const payload = toStructuredAgentErrorPayload(err);
        assert.equal(payload.retryable, true);
        assert.equal(payload.code, "GEMINI_TEMPORARILY_UNAVAILABLE");
        assert.equal(payload.status, statusCode === 429 ? 429 : 503);
        return true;
      }
    );

    assert.equal(attempts, 3, `Expected 3 total attempts for HTTP ${statusCode}`);
    assert.deepEqual(sleeps, [1000, 3000], `Expected [1000, 3000] backoff for HTTP ${statusCode}`);
  }
});

test("invalid API key and permission errors are not retried and never leak keys in logs", async () => {
  const fakeKey = "AIzaSySecretKeyNeverLeak987654321";
  let attempts = 0;
  const sleeps: number[] = [];
  const loggedStrings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => {
    loggedStrings.push(args.map(String).join(" "));
  };

  try {
    await assert.rejects(
      () =>
        executeWithGeminiRetry(
          async () => {
            attempts++;
            throw Object.assign(
              new Error(`API_KEY_INVALID: API key not valid for ${fakeKey}`),
              { status: 400 }
            );
          },
          {
            model: "gemini-3.6-flash",
            sleep: async (ms) => {
              sleeps.push(ms);
            },
            logger: (entry) => defaultGeminiRetryLogger(entry),
          }
        ),
      (err: unknown) => {
        const payload = toStructuredAgentErrorPayload(err);
        assert.equal(payload.retryable, false);
        assert.equal(payload.code, "GEMINI_INVALID_API_KEY");
        assert.equal(payload.status, 401);
        assert.doesNotMatch(payload.error, new RegExp(fakeKey));
        return true;
      }
    );
  } finally {
    console.warn = origWarn;
  }

  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(loggedStrings.length, 1);
  assert.match(loggedStrings[0], /model=gemini-3\.6-flash status=400 attempt=1\/3 elapsed=\d+ms/);
  assert.doesNotMatch(loggedStrings[0], new RegExp(fakeKey));
});

test("invalid model and malformed request errors are not retried", async () => {
  let modelAttempts = 0;
  const sleeps: number[] = [];

  await assert.rejects(
    () =>
      executeWithGeminiRetry(
        async () => {
          modelAttempts++;
          throw Object.assign(
            new Error("models/does-not-exist is not found for API version v1beta"),
            { status: 404 }
          );
        },
        {
          model: "does-not-exist",
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          logger: () => {},
        }
      ),
    (err: unknown) => {
      const payload = toStructuredAgentErrorPayload(err);
      assert.equal(payload.retryable, false);
      assert.equal(payload.code, "GEMINI_INVALID_MODEL");
      assert.equal(payload.status, 400);
      return true;
    }
  );
  assert.equal(modelAttempts, 1);
  assert.deepEqual(sleeps, []);

  const malformed = classifyGeminiError(
    Object.assign(new Error("INVALID_ARGUMENT: malformed contents payload"), { status: 400 })
  );
  assert.equal(malformed.retryable, false);
  assert.equal(malformed.code, "GEMINI_BAD_REQUEST");

  const forbidden = classifyGeminiError(
    Object.assign(new Error("PERMISSION_DENIED: caller lacks permission"), { status: 403 })
  );
  assert.equal(forbidden.retryable, false);
  assert.equal(forbidden.code, "GEMINI_PERMISSION_DENIED");
});

// --- UI Fake DOM Harness for duplicate-submit prevention & Running -> Execute + Retry tests ---

class FakeEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented = false;
  propagationStopped = false;
  immediatePropagationStopped = false;
  target: any = null;
  currentTarget: any = null;

  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  stopImmediatePropagation() {
    this.immediatePropagationStopped = true;
    this.propagationStopped = true;
  }
}

class FakeNode {
  nodeType: number;
  nodeName: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  listeners = new Map<string, Array<{ fn: (e: any) => void; capture: boolean }>>();

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? this.parentNode.childNodes[idx + 1] ?? null : null;
  }

  get parentElement(): FakeElement | null {
    return this.parentNode && this.parentNode.nodeType === 1
      ? (this.parentNode as FakeElement)
      : null;
  }

  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends FakeNode>(newNode: T, refNode: FakeNode | null): T {
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    newNode.parentNode = this;
    if (!refNode) {
      this.childNodes.push(newNode);
    } else {
      const idx = this.childNodes.indexOf(refNode);
      if (idx === -1) this.childNodes.push(newNode);
      else this.childNodes.splice(idx, 0, newNode);
    }
    return newNode;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  contains(other: FakeNode | null): boolean {
    let curr: FakeNode | null = other;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  addEventListener(type: string, fn: (e: any) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: string,
    fn: (e: any) => void,
    options?: boolean | { capture?: boolean }
  ) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(
      type,
      list.filter((entry) => !(entry.fn === fn && entry.capture === capture))
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target = this;
    const path: FakeNode[] = [];
    let curr: FakeNode | null = this;
    while (curr) {
      path.unshift(curr);
      curr = curr.parentNode;
    }
    if (path[0] !== this.ownerDocument) {
      path.unshift(this.ownerDocument);
    }

    for (const node of path) {
      if (event.propagationStopped) break;
      event.currentTarget = node;
      for (const entry of [...(node.listeners.get(event.type) ?? [])]) {
        if (entry.capture) {
          entry.fn(event);
          if (event.immediatePropagationStopped) break;
        }
      }
    }

    const bubblePath = event.bubbles ? [...path].reverse() : [this];
    for (const node of bubblePath) {
      if (event.propagationStopped) break;
      event.currentTarget = node;
      for (const entry of [...(node.listeners.get(event.type) ?? [])]) {
        if (!entry.capture) {
          entry.fn(event);
          if (event.immediatePropagationStopped) break;
        }
      }
    }

    return !event.defaultPrevented;
  }
}

class FakeText extends FakeNode {
  data: string;
  constructor(text: string, ownerDocument: FakeDocument) {
    super(3, "#text", ownerDocument);
    this.data = String(text);
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(val: string) {
    this.data = String(val);
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(val: string) {
    this.data = String(val);
  }
}

class FakeComment extends FakeNode {
  data: string;
  constructor(text: string, ownerDocument: FakeDocument) {
    super(8, "#comment", ownerDocument);
    this.data = String(text);
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  namespaceURI: string;
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  value = "";
  disabled = false;
  checked = false;

  constructor(tagName: string, ownerDocument: FakeDocument, namespaceURI = "http://www.w3.org/1999/xhtml") {
    super(1, tagName.toUpperCase(), ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespaceURI;
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }
  set className(val: string) {
    this.attributes.set("class", val);
  }
  get textContent(): string {
    return this.childNodes.map((child) => (child as any).textContent ?? "").join("");
  }
  set textContent(val: string) {
    this.childNodes.length = 0;
    if (val) this.appendChild(this.ownerDocument.createTextNode(val));
  }
  set innerHTML(val: string) {
    if (val === "") this.childNodes.length = 0;
  }
  setAttribute(name: string, val: string) {
    const str = String(val);
    this.attributes.set(name, str);
    if (name === "disabled") this.disabled = true;
    if (name === "value") this.value = str;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "disabled") this.disabled = false;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  scrollIntoView() {}
  click() {
    if (this.disabled) return;
    const clickEv = new FakeEvent("click", { bubbles: true, cancelable: true });
    this.dispatchEvent(clickEv);
    if (!clickEv.defaultPrevented && this.tagName === "BUTTON" && this.getAttribute("type") === "submit") {
      let curr: FakeNode | null = this.parentNode;
      while (curr) {
        if (curr instanceof FakeElement && curr.tagName === "FORM") {
          curr.dispatchEvent(new FakeEvent("submit", { bubbles: true, cancelable: true }));
          break;
        }
        curr = curr.parentNode;
      }
    }
  }
}

class FakeDocument extends FakeNode {
  documentElement: FakeElement;
  body: FakeElement;
  head: FakeElement;
  activeElement: FakeElement | null = null;
  defaultView: any = null;

  constructor() {
    super(9, "#document", null as any);
    this.ownerDocument = this;
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
  createElementNS(ns: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this, ns);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(text, this);
  }
  createComment(text: string): FakeComment {
    return new FakeComment(text, this);
  }
}

function installFakeDom() {
  const doc = new FakeDocument();
  const prev = {
    window: (globalThis as any).window,
    document: (globalThis as any).document,
    Element: (globalThis as any).Element,
    HTMLElement: (globalThis as any).HTMLElement,
    HTMLIFrameElement: (globalThis as any).HTMLIFrameElement,
    Node: (globalThis as any).Node,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  };

  const win = {
    document: doc,
    HTMLIFrameElement: class FakeHTMLIFrameElement extends FakeElement {},
    HTMLElement: FakeElement,
    Element: FakeElement,
    Node: FakeNode,
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  doc.defaultView = win;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).document = doc;
  (globalThis as any).Element = FakeElement;
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).HTMLIFrameElement = win.HTMLIFrameElement;
  (globalThis as any).Node = FakeNode;
  (globalThis as any).window = win;

  return {
    doc,
    restore() {
      (globalThis as any).window = prev.window;
      (globalThis as any).document = prev.document;
      (globalThis as any).Element = prev.Element;
      (globalThis as any).HTMLElement = prev.HTMLElement;
      (globalThis as any).HTMLIFrameElement = prev.HTMLIFrameElement;
      (globalThis as any).Node = prev.Node;
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

function collectElements(root: FakeElement): FakeElement[] {
  const result: FakeElement[] = [];
  const visit = (node: FakeNode) => {
    if (node instanceof FakeElement) result.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return result;
}

function findButtonByText(root: FakeElement, text: string): FakeElement {
  const match = collectElements(root).find(
    (el) => el.tagName === "BUTTON" && el.textContent.trim().includes(text)
  );
  assert.ok(match, `Expected button containing "${text}" in DOM`);
  return match;
}

let tmpUiDir: string;
let AppComponent: React.FC<any>;

before(async () => {
  tmpUiDir = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-retry-ui-"));
  const outfile = path.join(tmpUiDir, "app.mjs");
  const entry = path.join(tmpUiDir, "entry.ts");

  await fs.writeFile(
    entry,
    `export { default as App } from ${JSON.stringify(
      path.resolve(process.cwd(), "src", "App.tsx")
    )};\n`,
    "utf-8"
  );

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    plugins: [
      {
        name: "externalize-node-modules",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.kind === "entry-point" || /^[a-zA-Z]:/.test(args.path)) {
              return undefined;
            }
            if (args.path.startsWith("node:") || args.path.startsWith("file:")) {
              return { path: args.path, external: true };
            }
            return {
              path: import.meta.resolve(args.path),
              external: true,
            };
          });
        },
      },
    ],
    outfile,
  });

  const mod = await import(pathToFileURL(outfile).href);
  AppComponent = mod.App;
});

after(async () => {
  if (tmpUiDir) {
    await fs.rm(tmpUiDir, { recursive: true, force: true });
  }
});

const TEST_PROJECT: ProjectSummary = {
  id: "proj-retry",
  name: "retry-project",
  slug: "retry-project",
  workspacePath: "/tmp/projects/retry-project",
  isDefault: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const TEST_SESSION: SessionSummary = {
  id: "sess-retry",
  projectId: "proj-retry",
  title: "Retry Test Session",
  channel: "browser",
  externalChatId: null,
  model: "gemini-3.6-flash",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const READY_RUNTIME: RuntimeStatus = {
  executionMode: "docker",
  authRequired: false,
  provider: { id: "gemini", displayName: "Google Gemini", apiKeyConfigured: true },
  containerRuntime: {
    configuredRuntime: "auto",
    selectedRuntime: "docker",
    image: "ghcr.io/jqcvsc/nanogem-sandbox:latest",
    user: "1000:1000",
    network: "none",
    networkEnabled: false,
    executionMode: "docker",
    cpus: "1.0",
    memory: "512m",
    pidsLimit: 64,
    readOnly: true,
    available: true,
    imagePresent: true,
  },
  docker: null,
};

test("UI prevents duplicate submissions while active, returns from Running to Execute on 503, preserves prompt, and Retry resubmits once", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let resolveFirstFetch!: (res: Response) => void;
  const firstFetchPromise = new Promise<Response>((resolve) => {
    resolveFirstFetch = resolve;
  });

  (globalThis as any).fetch = async (url: string) => {
    if (String(url).includes("/api/agent/chat/stream")) {
      fetchCount++;
      if (fetchCount === 1) {
        return firstFetchPromise;
      }
      return new Response(
        JSON.stringify({
          text: "Succeeded on manual retry.",
          executionSteps: [],
          files: [],
          sessionId: TEST_SESSION.id,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    await act(async () => {
      root.render(
        React.createElement(AppComponent, {
          skipInitialFetch: true,
          initialTab: "chat",
          initialRuntimeStatus: READY_RUNTIME,
          initialProjects: [TEST_PROJECT],
          initialProjectId: TEST_PROJECT.id,
          initialSessions: [TEST_SESSION],
          initialActiveSessionId: TEST_SESSION.id,
        })
      );
    });

    // Click a sample prompt card to launch an initial prompt submission
    const sampleCard = findButtonByText(
      container,
      "Inspect repository files and summarize architecture"
    );
    await act(async () => {
      sampleCard.click();
    });

    assert.equal(fetchCount, 1);
    const submitBtnWhileRunning = collectElements(container).find(
      (el) => el.tagName === "BUTTON" && el.getAttribute("type") === "submit"
    );
    assert.ok(submitBtnWhileRunning);
    assert.match(submitBtnWhileRunning.textContent, /Running/);
    assert.equal(submitBtnWhileRunning.disabled, true);

    // Attempt duplicate submissions while active (submit button + form submit + slash chip)
    const form = collectElements(container).find((el) => el.tagName === "FORM");
    assert.ok(form);
    await act(async () => {
      submitBtnWhileRunning.click();
      form.dispatchEvent(new FakeEvent("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(fetchCount, 1, "Duplicate submission must be prevented while request is active");

    // Resolve the active request with structured 503 error
    await act(async () => {
      resolveFirstFetch(
        new Response(
          JSON.stringify({
            error:
              "Gemini is temporarily unavailable because the selected model is under high demand. Please try again shortly.",
            code: "GEMINI_TEMPORARILY_UNAVAILABLE",
            retryable: true,
            status: 503,
          }),
          { status: 503, headers: { "content-type": "application/json" } }
        )
      );
    });

    // Stops showing Running, returns button to Execute, preserves prompt, shows error + Retry button
    const submitBtnAfterFailure = collectElements(container).find(
      (el) => el.tagName === "BUTTON" && el.getAttribute("type") === "submit"
    );
    assert.ok(submitBtnAfterFailure);
    assert.match(submitBtnAfterFailure.textContent, /Execute/);
    assert.doesNotMatch(submitBtnAfterFailure.textContent, /Running/);

    const textarea = collectElements(container).find((el) => el.tagName === "TEXTAREA");
    assert.ok(textarea);
    assert.equal(textarea.value, "Inspect repository files and summarize architecture");

    const errorBanner = collectElements(container).find(
      (el) => el.getAttribute("data-testid") === "agent-error-banner"
    );
    assert.ok(errorBanner);
    assert.match(
      errorBanner.textContent,
      /Gemini is temporarily unavailable because the selected model is under high demand\./
    );

    const retryBtn = findButtonByText(errorBanner, "Retry");
    await act(async () => {
      retryBtn.click();
    });

    assert.equal(fetchCount, 2, "Retry button should resubmit the failed prompt once");
    assert.match(container.textContent, /Succeeded on manual retry\./);
    assert.equal(
      collectElements(container).some((el) => el.getAttribute("data-testid") === "agent-error-banner"),
      false
    );
    assert.equal(textarea.value, "");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test("model fallback: primary success uses configured primary model without invoking fallback", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-fallback-primary-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "docker" });
    const calledModels: string[] = [];

    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent(params) {
          calledModels.push(params.model);
          return {
            text: "Primary answer",
            candidates: [{ content: { role: "model", parts: [{ text: "Primary answer" }] } }],
            functionCalls: [],
          };
        },
      },
    };

    const result = await runGeminiAgent(
      {
        message: "Run on primary",
        model: DEFAULT_GEMINI_MODEL,
        sandboxConfig: cfg,
      },
      { client: mockClient, sleep: async () => {}, logger: () => {} }
    );

    assert.deepEqual(calledModels, [DEFAULT_GEMINI_MODEL]);
    assert.equal(result.configuredModel, DEFAULT_GEMINI_MODEL);
    assert.equal(result.modelUsed, DEFAULT_GEMINI_MODEL);
    assert.equal(result.fallbackUsed, false);
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("model fallback: primary 503 after retries triggers single fallback attempt and preserves configured model", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-fallback-503-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "docker" });
    const calledModels: string[] = [];
    const logs: GeminiRetryLogEntry[] = [];
    let tick = 100;

    const mockClient: GeminiGenerateContentClient = {
      models: {
        async generateContent(params) {
          calledModels.push(params.model);
          tick += 25;
          if (params.model === DEFAULT_GEMINI_MODEL) {
            throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
          }
          return {
            text: "Fallback answer",
            candidates: [{ content: { role: "model", parts: [{ text: "Fallback answer" }] } }],
            functionCalls: [],
          };
        },
      },
    };

    const result = await runGeminiAgent(
      {
        message: "Need answer despite 503",
        model: DEFAULT_GEMINI_MODEL,
        fallbackModel: DEFAULT_FALLBACK_GEMINI_MODEL,
        sandboxConfig: cfg,
      },
      {
        client: mockClient,
        sleep: async () => {},
        now: () => tick,
        logger: (entry) => logs.push(entry),
      }
    );

    // 3 attempts on primary (initial + 2 retries), then 1 attempt on fallback
    assert.deepEqual(calledModels, [
      DEFAULT_GEMINI_MODEL,
      DEFAULT_GEMINI_MODEL,
      DEFAULT_GEMINI_MODEL,
      DEFAULT_FALLBACK_GEMINI_MODEL,
    ]);
    assert.equal(result.text, "Fallback answer");
    assert.equal(result.configuredModel, DEFAULT_GEMINI_MODEL);
    assert.equal(result.modelUsed, DEFAULT_FALLBACK_GEMINI_MODEL);
    assert.equal(result.fallbackUsed, true);

    assert.equal(logs.length, 4);
    assert.equal(logs[3].model, DEFAULT_FALLBACK_GEMINI_MODEL);
    assert.equal(logs[3].status, 200);
    assert.equal(logs[3].attempt, 1);
    assert.ok(logs[3].elapsedMs >= 25);

    // Next turn with non-failing client still attempts configured primary model first (never permanently replaced)
    const nextCalls: string[] = [];
    const recoveredClient: GeminiGenerateContentClient = {
      models: {
        async generateContent(params) {
          nextCalls.push(params.model);
          return {
            text: "Back on primary",
            candidates: [{ content: { role: "model", parts: [{ text: "Back on primary" }] } }],
            functionCalls: [],
          };
        },
      },
    };
    const nextRes = await runGeminiAgent(
      {
        message: "Second prompt",
        sandboxConfig: cfg,
      },
      { client: recoveredClient, sleep: async () => {}, logger: () => {} }
    );
    assert.deepEqual(nextCalls, [DEFAULT_GEMINI_MODEL]);
    assert.equal(nextRes.modelUsed, DEFAULT_GEMINI_MODEL);
    assert.equal(nextRes.fallbackUsed, false);
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("model fallback: both primary and fallback failing throws clear error; non-retryable errors do not fallback", async () => {
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-fallback-both-"));
  try {
    const cfg = loadSandboxConfig(tmpWs, { NANOGEM_EXECUTION_MODE: "docker" });
    const calledBoth: string[] = [];
    const logs: GeminiRetryLogEntry[] = [];

    const bothFailClient: GeminiGenerateContentClient = {
      models: {
        async generateContent(params) {
          calledBoth.push(params.model);
          if (params.model === DEFAULT_GEMINI_MODEL) {
            throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
          }
          throw Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 });
        },
      },
    };

    await assert.rejects(
      () =>
        runGeminiAgent(
          {
            message: "Both fail",
            model: DEFAULT_GEMINI_MODEL,
            fallbackModel: DEFAULT_FALLBACK_GEMINI_MODEL,
            sandboxConfig: cfg,
          },
          {
            client: bothFailClient,
            sleep: async () => {},
            logger: (entry) => logs.push(entry),
          }
        ),
      (err: unknown) => {
        const payload = toStructuredAgentErrorPayload(err);
        assert.match(payload.error, new RegExp(DEFAULT_GEMINI_MODEL));
        assert.match(payload.error, new RegExp(DEFAULT_FALLBACK_GEMINI_MODEL));
        assert.equal(payload.retryable, true);
        assert.equal(payload.code, "GEMINI_TEMPORARILY_UNAVAILABLE");
        return true;
      }
    );

    assert.deepEqual(calledBoth, [
      DEFAULT_GEMINI_MODEL,
      DEFAULT_GEMINI_MODEL,
      DEFAULT_GEMINI_MODEL,
      DEFAULT_FALLBACK_GEMINI_MODEL,
    ]);
    assert.equal(logs[3].model, DEFAULT_FALLBACK_GEMINI_MODEL);
    assert.equal(logs[3].status, 429);
    assert.equal(logs[3].attempt, 1);

    // Invalid API key / invalid model / permission / malformed errors never fallback
    for (const err of [
      Object.assign(new Error("API_KEY_INVALID"), { status: 400 }),
      Object.assign(new Error("PERMISSION_DENIED"), { status: 403 }),
      Object.assign(new Error("INVALID_ARGUMENT: malformed"), { status: 400 }),
      Object.assign(new Error("models/bad-model is not found"), { status: 404 }),
    ]) {
      const nonFallbackCalls: string[] = [];
      await assert.rejects(() =>
        runGeminiAgent(
          {
            message: "Should not fallback",
            model: DEFAULT_GEMINI_MODEL,
            fallbackModel: DEFAULT_FALLBACK_GEMINI_MODEL,
            sandboxConfig: cfg,
          },
          {
            client: {
              models: {
                async generateContent(params) {
                  nonFallbackCalls.push(params.model);
                  throw err;
                },
              },
            },
            sleep: async () => {},
            logger: () => {},
          }
        )
      );
      assert.deepEqual(nonFallbackCalls, [DEFAULT_GEMINI_MODEL]);
    }
  } finally {
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("UI displays which model answered (including fallback badge) without altering configured model", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const originalFetch = globalThis.fetch;
  const requestedModels: string[] = [];
  let turn = 0;

  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/agent/chat/stream")) {
      const body = JSON.parse(String(init?.body || "{}"));
      requestedModels.push(body.model);
      turn++;
      return new Response(
        JSON.stringify(
          turn === 1
            ? {
                text: "Answered using fallback model.",
                executionSteps: [],
                files: [],
                sessionId: TEST_SESSION.id,
                configuredModel: DEFAULT_GEMINI_MODEL,
                modelUsed: DEFAULT_FALLBACK_GEMINI_MODEL,
                fallbackUsed: true,
              }
            : {
                text: "Answered using primary model.",
                executionSteps: [],
                files: [],
                sessionId: TEST_SESSION.id,
                configuredModel: DEFAULT_GEMINI_MODEL,
                modelUsed: DEFAULT_GEMINI_MODEL,
                fallbackUsed: false,
              }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    await act(async () => {
      root.render(
        React.createElement(AppComponent, {
          skipInitialFetch: true,
          initialTab: "chat",
          initialRuntimeStatus: READY_RUNTIME,
          initialProjects: [TEST_PROJECT],
          initialProjectId: TEST_PROJECT.id,
          initialSessions: [TEST_SESSION],
          initialActiveSessionId: TEST_SESSION.id,
        })
      );
    });

    await act(async () => {
      findButtonByText(container, "Inspect repository files and summarize architecture").click();
    });

    const badgesAfterFirst = collectElements(container).filter(
      (el) => el.getAttribute("data-testid") === "message-model-badge"
    );
    assert.equal(badgesAfterFirst.length, 1);
    assert.match(
      badgesAfterFirst[0].textContent,
      /Model: gemini-3\.8-flash \(fallback from gemini-3\.6-flash\)/
    );

    // Send another prompt via slash chip + Execute: verify configured model stayed gemini-3.6-flash
    await act(async () => {
      findButtonByText(container, "/test").click();
    });
    const submitBtn = collectElements(container).find(
      (el) => el.tagName === "BUTTON" && el.getAttribute("type") === "submit"
    );
    assert.ok(submitBtn);
    await act(async () => {
      submitBtn.click();
    });

    assert.deepEqual(requestedModels, [DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_MODEL]);
    const badgesAfterSecond = collectElements(container).filter(
      (el) => el.getAttribute("data-testid") === "message-model-badge"
    );
    assert.equal(badgesAfterSecond.length, 2);
    assert.equal(badgesAfterSecond[1].textContent.trim(), "Model: gemini-3.6-flash");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});
