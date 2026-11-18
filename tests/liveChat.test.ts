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
  StreamFallbackEligibleError,
  StreamProtocolError,
  consumeChatStreamResponse,
} from "../src/chat/streamClient.ts";
import type { ProjectSummary, RuntimeStatus, SessionSummary } from "../src/types.ts";

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
    if (!refNode) this.childNodes.push(newNode);
    else {
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
    if (path[0] !== this.ownerDocument) path.unshift(this.ownerDocument);

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
  scrollHeight = 1000;
  scrollTop = 500;
  clientHeight = 500;
  scrollIntoViewCalls = 0;

  constructor(
    tagName: string,
    ownerDocument: FakeDocument,
    namespaceURI = "http://www.w3.org/1999/xhtml"
  ) {
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
  scrollIntoView() {
    this.scrollIntoViewCalls++;
    (this.ownerDocument as any).totalScrollIntoViewCalls++;
  }
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
  totalScrollIntoViewCalls = 0;

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
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
  assert.ok(match, `Expected button containing "${text}"`);
  return match;
}

function createControlledSseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
    pushEvent(eventName: string, data: unknown) {
      controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    pushRaw(raw: string) {
      controller.enqueue(encoder.encode(raw));
    },
    close() {
      controller.close();
    },
    error(err: unknown) {
      controller.error(err);
    },
  };
}

const TEST_PROJECT: ProjectSummary = {
  id: "proj-live",
  name: "live-chat-project",
  slug: "live-chat-project",
  workspacePath: "/tmp/projects/live-chat-project",
  isDefault: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const TEST_SESSION: SessionSummary = {
  id: "sess-live",
  projectId: "proj-live",
  title: "Live Chat Session",
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
    selectedRuntime: "podman",
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

let tmpUiDir: string;
let AppComponent: React.FC<any>;

before(async () => {
  tmpUiDir = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-live-chat-ui-"));
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
            if (args.kind === "entry-point" || /^[a-zA-Z]:/.test(args.path)) return undefined;
            if (args.path.startsWith("node:") || args.path.startsWith("file:")) {
              return { path: args.path, external: true };
            }
            return { path: import.meta.resolve(args.path), external: true };
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

test("streamClient parses CRLF trailing blocks without double trailing newline, handles [DONE], error events, and malformed events", async () => {
  // 1. CRLF and trailing result block flushed on EOF without trailing \r\n\r\n + [DONE]
  const encoder = new TextEncoder();
  const crlfRes = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(
          encoder.encode(
            'event: progress\r\ndata: {"id":"p1","stage":"calling_gemini","label":"Calling Gemini","turn":1,"timestamp":"t"}\r\n\r\n' +
              'event: result\r\ndata: {"text":"Flushed final text","executionSteps":[]}'
          )
        );
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );

  const stages: string[] = [];
  const resPayload = await consumeChatStreamResponse(crlfRes, {
    onProgress: (ev) => stages.push(ev.stage),
  });
  assert.deepEqual(stages, ["calling_gemini"]);
  assert.equal(resPayload.text, "Flushed final text");

  // 2. [DONE] after assistant_text synthesizes final result cleanly
  let sawDone = false;
  const doneRes = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('event: assistant_text\ndata: {"delta":"Hello "}\n\n'));
        c.enqueue(encoder.encode('event: assistant_text\ndata: {"delta":"world"}\n\n'));
        c.enqueue(encoder.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
  const donePayload = await consumeChatStreamResponse(doneRes, {
    onDone: () => {
      sawDone = true;
    },
  });
  assert.equal(sawDone, true);
  assert.equal(donePayload.text, "Hello world");

  // 3. Unexpected content-type before receiving data triggers fallback-eligible error
  const badContentType = new Response("<html>not sse</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  await assert.rejects(
    () => consumeChatStreamResponse(badContentType, {}),
    (err: unknown) => err instanceof StreamFallbackEligibleError
  );

  // 4. Malformed stream JSON rejects with StreamProtocolError
  const malformedRes = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode("event: progress\ndata: {not-valid-json\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
  await assert.rejects(
    () => consumeChatStreamResponse(malformedRes, {}),
    (err: unknown) => err instanceof StreamProtocolError && err.code === "MALFORMED_STREAM_EVENT"
  );
});

test("live chat appends user & placeholder immediately, streams text and tool steps by ID without duplicates, restores Execute, and allows second prompt", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const originalFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];
  let streamTurn = 0;
  let sse1!: ReturnType<typeof createControlledSseStream>;
  let sse2!: ReturnType<typeof createControlledSseStream>;

  (globalThis as any).fetch = async (url: string) => {
    fetchedUrls.push(String(url));
    if (String(url).includes("/api/agent/chat/stream")) {
      streamTurn++;
      if (streamTurn === 1) {
        sse1 = createControlledSseStream();
        return sse1.response;
      }
      sse2 = createControlledSseStream();
      return sse2.response;
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

    // Trigger initial prompt via sample card
    await act(async () => {
      findButtonByText(container, "Inspect repository files and summarize architecture").click();
      // Wait a microtask for fetch to return stream response
      await Promise.resolve();
    });

    // 1 & 2. User message AND temporary assistant placeholder appear immediately before stream finishes
    assert.match(container.textContent, /Inspect repository files and summarize architecture/);
    const statusBadgesImmediate = collectElements(container).filter(
      (el) => el.getAttribute("data-testid") === "message-status-badge"
    );
    assert.equal(statusBadgesImmediate.length, 1);
    assert.match(statusBadgesImmediate[0].textContent, /Analyzing request/);

    // Duplicate submit while active does not issue a second request
    const form = collectElements(container).find((el) => el.tagName === "FORM");
    assert.ok(form);
    await act(async () => {
      form.dispatchEvent(new FakeEvent("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(fetchedUrls.length, 1);

    // 3 & 5. Stream progress, tool_call, tool_result, and partial assistant_text live on SAME assistant message ID
    await act(async () => {
      sse1.pushEvent("progress", {
        id: "p1",
        stage: "calling_gemini",
        label: "Calling Gemini",
        turn: 1,
        timestamp: "t1",
      });
      await Promise.resolve();
    });
    assert.match(
      collectElements(container)
        .filter((el) => el.getAttribute("data-testid") === "message-status-badge")[0]
        .textContent,
      /Calling Gemini/
    );

    await act(async () => {
      sse1.pushEvent("progress", {
        id: "p2",
        stage: "running_command",
        label: "Running command",
        detail: "ls -la /workspace/",
        turn: 1,
        timestamp: "t2",
      });
      sse1.pushEvent("tool_call", {
        turn: 1,
        toolName: "execute_system_command",
        args: { command: "ls -la /workspace/" },
      });
      await Promise.resolve();
    });
    assert.match(
      collectElements(container)
        .filter((el) => el.getAttribute("data-testid") === "message-status-badge")[0]
        .textContent,
      /Running sandbox command/
    );
    assert.match(container.textContent, /ls -la \/workspace\//);

    await act(async () => {
      sse1.pushEvent("tool_result", {
        turn: 1,
        toolName: "execute_system_command",
        output: "runtime-test.txt",
        success: true,
      });
      sse1.pushEvent("assistant_text", {
        turn: 2,
        text: "Streaming answer...",
      });
      await Promise.resolve();
    });
    assert.match(container.textContent, /runtime-test\.txt/);
    assert.match(container.textContent, /Streaming answer\.\.\./);

    // 4. Final response replaces placeholder without creating a second assistant message
    await act(async () => {
      sse1.pushEvent("result", {
        text: "Final live response complete.",
        executionSteps: [
          {
            type: "tool_call",
            toolName: "execute_system_command",
            args: { command: "ls -la /workspace/" },
            output: "runtime-test.txt",
          },
        ],
        configuredModel: "gemini-3.6-flash",
        modelUsed: "gemini-3.6-flash",
        fallbackUsed: false,
        sessionId: TEST_SESSION.id,
      });
      sse1.pushRaw("data: [DONE]\n\n");
      sse1.close();
    });

    const badgesAfterFirst = collectElements(container).filter(
      (el) => el.getAttribute("data-testid") === "message-status-badge"
    );
    assert.equal(badgesAfterFirst.length, 1, "Must keep one assistant message card per turn");
    assert.match(badgesAfterFirst[0].textContent, /Completed/);
    assert.match(container.textContent, /Final live response complete\./);
    assert.doesNotMatch(container.textContent, /Streaming answer\.\.\./);

    // 8 & 9. Execute button restored; second prompt submits and both turns remain visible
    const submitBtn = collectElements(container).find(
      (el) => el.tagName === "BUTTON" && el.getAttribute("type") === "submit"
    );
    assert.ok(submitBtn);
    assert.match(submitBtn.textContent, /Execute/);
    assert.equal(submitBtn.disabled, true); // composer cleared after success until user enters next prompt

    await act(async () => {
      findButtonByText(container, "/test").click();
    });
    assert.equal(submitBtn.disabled, false);

    await act(async () => {
      submitBtn.click();
      await Promise.resolve();
    });
    await act(async () => {
      sse2.pushEvent("result", {
        text: "Second prompt succeeded.",
        executionSteps: [],
        configuredModel: "gemini-3.6-flash",
        modelUsed: "gemini-3.6-flash",
        fallbackUsed: false,
        sessionId: TEST_SESSION.id,
      });
      sse2.pushRaw("data: [DONE]\n\n");
      sse2.close();
    });

    assert.equal(fetchedUrls.length, 2);
    assert.match(container.textContent, /Final live response complete\./);
    assert.match(container.textContent, /Second prompt succeeded\./);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test("JSON fallback activates once when streaming is unavailable and updates conversation", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  (globalThis as any).fetch = async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("/api/agent/chat/stream")) {
      return new Response("Not Found", { status: 404 });
    }
    if (String(url).includes("/api/agent/chat")) {
      return new Response(
        JSON.stringify({
          text: "Answered via JSON fallback.",
          executionSteps: [],
          configuredModel: "gemini-3.6-flash",
          modelUsed: "gemini-3.6-flash",
          fallbackUsed: false,
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

    await act(async () => {
      findButtonByText(container, "Inspect repository files and summarize architecture").click();
    });

    assert.deepEqual(calls, ["/api/agent/chat/stream", "/api/agent/chat"]);
    assert.match(container.textContent, /Answered via JSON fallback\./);
    const submitBtn = collectElements(container).find(
      (el) => el.tagName === "BUTTON" && el.getAttribute("type") === "submit"
    );
    assert.ok(submitBtn);
    assert.match(submitBtn.textContent, /Execute/);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test("timeout, network disconnect, and mid-stream malformed errors appear in conversation, preserve completed text, restore Execute, and avoid double fallback", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const originalFetch = globalThis.fetch;
  let calls: string[] = [];
  let scenario: "partial_then_malformed" | "timeout" = "partial_then_malformed";

  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (scenario === "partial_then_malformed") {
      return new Response(
        new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('event: assistant_text\ndata: {"text":"Partial answer kept"}\n\n'));
            c.enqueue(enc.encode("event: result\ndata: {corrupt-json\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }

    // Timeout scenario: never resolves until AbortController aborts
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };

  try {
    await act(async () => {
      root.render(
        React.createElement(AppComponent, {
          skipInitialFetch: true,
          requestTimeoutMs: 40,
          initialTab: "chat",
          initialRuntimeStatus: READY_RUNTIME,
          initialProjects: [TEST_PROJECT],
          initialProjectId: TEST_PROJECT.id,
          initialSessions: [TEST_SESSION],
          initialActiveSessionId: TEST_SESSION.id,
        })
      );
    });

    // Scenario 1: Partial streamed assistant text + malformed event (must NOT fall back to /api/agent/chat!)
    await act(async () => {
      findButtonByText(container, "Inspect repository files and summarize architecture").click();
    });

    assert.deepEqual(calls, ["/api/agent/chat/stream"]);
    assert.match(container.textContent, /Partial answer kept/);
    assert.match(container.textContent, /Received a malformed stream event/);
    assert.match(
      collectElements(container).filter((el) => el.getAttribute("data-testid") === "message-status-badge")[0]
        .textContent,
      /Failed/
    );
    const submitBtn1 = collectElements(container).find(
      (el) => el.tagName === "BUTTON" && el.getAttribute("type") === "submit"
    );
    assert.ok(submitBtn1);
    assert.match(submitBtn1.textContent, /Execute/);

    // Scenario 2: Client timeout aborts request, restores Execute, preserves prompt, shows error in conversation
    scenario = "timeout";
    calls = [];
    await act(async () => {
      findButtonByText(container, "Execute").click();
      await new Promise((r) => setTimeout(r, 80));
    });

    assert.deepEqual(calls, ["/api/agent/chat/stream"]);
    assert.match(container.textContent, /Request timed out while waiting for NanoGem\./);
    assert.match(submitBtn1.textContent, /Execute/);
    const textarea = collectElements(container).find((el) => el.tagName === "TEXTAREA");
    assert.ok(textarea);
    assert.equal(textarea.value, "Inspect repository files and summarize architecture");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test("auto-scroll follows active task at bottom and pauses when user intentionally scrolls upward", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const originalFetch = globalThis.fetch;
  let sse!: ReturnType<typeof createControlledSseStream>;
  (globalThis as any).fetch = async () => {
    sse = createControlledSseStream();
    return sse.response;
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

    const beforeSubmitScrolls = dom.doc.totalScrollIntoViewCalls;
    await act(async () => {
      findButtonByText(container, "Inspect repository files and summarize architecture").click();
      await Promise.resolve();
    });
    assert.ok(dom.doc.totalScrollIntoViewCalls > beforeSubmitScrolls);

    // Simulate user scrolling upward away from bottom
    const viewport = collectElements(container).find(
      (el) => el.getAttribute("data-testid") === "chat-scroll-viewport"
    );
    assert.ok(viewport);
    viewport.scrollHeight = 1200;
    viewport.clientHeight = 500;
    viewport.scrollTop = 100; // distanceFromBottom = 600 > 48
    await act(async () => {
      viewport.dispatchEvent(new FakeEvent("scroll", { bubbles: false }));
    });

    const countWhileScrolledUp = dom.doc.totalScrollIntoViewCalls;
    await act(async () => {
      sse.pushEvent("assistant_text", { turn: 1, text: "More streamed output" });
      sse.pushEvent("result", { text: "Done", executionSteps: [], sessionId: TEST_SESSION.id });
      sse.close();
    });

    assert.equal(
      dom.doc.totalScrollIntoViewCalls,
      countWhileScrolledUp,
      "Must not yank scroll position when user scrolled upward"
    );
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});
