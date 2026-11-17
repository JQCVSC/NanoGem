import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import esbuild from "esbuild";
import type { ChatMessage, ProjectSummary, RuntimeStatus, SessionSummary } from "../src/types.ts";

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
    if (newNode.parentNode) {
      newNode.parentNode.removeChild(newNode);
    }
    newNode.parentNode = this;
    if (!refNode) {
      this.childNodes.push(newNode);
    } else {
      const idx = this.childNodes.indexOf(refNode);
      if (idx === -1) {
        this.childNodes.push(newNode);
      } else {
        this.childNodes.splice(idx, 0, newNode);
      }
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
      const entries = [...(node.listeners.get(event.type) ?? [])];
      for (const entry of entries) {
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
      const entries = [...(node.listeners.get(event.type) ?? [])];
      for (const entry of entries) {
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
    if (val) {
      this.appendChild(this.ownerDocument.createTextNode(val));
    }
  }

  set innerHTML(val: string) {
    if (val === "") {
      this.childNodes.length = 0;
    }
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
    // No-op in headless test DOM
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent("click", { bubbles: true, cancelable: true }));
  }
}

class FakeDocument extends FakeNode {
  documentElement: FakeElement;
  body: FakeElement;
  head: FakeElement;
  activeElement: FakeElement | null = null;

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

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).document = doc;
  (globalThis as any).Element = FakeElement;
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).Node = FakeNode;
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
  (doc as any).defaultView = win;
  (globalThis as any).window = win;
  (globalThis as any).HTMLIFrameElement = win.HTMLIFrameElement;

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
    if (node instanceof FakeElement) {
      result.push(node);
    }
    for (const child of node.childNodes) {
      visit(child);
    }
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

function findByTestId(root: FakeElement, testId: string): FakeElement {
  const match = collectElements(root).find((el) => el.getAttribute("data-testid") === testId);
  assert.ok(match, `Expected element with data-testid="${testId}"`);
  return match;
}

const SAMPLE_PROJECT: ProjectSummary = {
  id: "proj-alpha",
  name: "alpha-service",
  slug: "alpha-service",
  workspacePath: "/tmp/projects/alpha-service",
  isDefault: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SECOND_PROJECT: ProjectSummary = {
  id: "proj-beta",
  name: "beta-worker",
  slug: "beta-worker",
  workspacePath: "/tmp/projects/beta-worker",
  isDefault: false,
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const SAMPLE_SESSION: SessionSummary = {
  id: "sess-1",
  projectId: "proj-alpha",
  title: "Auth Refactor Investigation",
  channel: "browser",
  externalChatId: null,
  model: "gemini-3.6-flash",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const READY_RUNTIME_STATUS: RuntimeStatus = {
  executionMode: "docker",
  authRequired: false,
  provider: {
    id: "gemini",
    displayName: "Google Gemini",
    apiKeyConfigured: true,
  },
  containerRuntime: {
    configuredRuntime: "auto",
    selectedRuntime: "docker",
    image: "ghcr.io/jqcvsc/nanogem-sandbox:sha-7f67fe91cad77f2c5ed2da9a0ea9284517d67879",
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
    serverVersion: "27.5.1",
  },
  docker: null,
  projectContext: {
    projectId: "proj-alpha",
    hasGeminiMd: true,
    hasMemoryMd: true,
    isGitRepo: true,
    hasUncommittedChanges: false,
    branch: "feat/dashboard",
  },
};

const NOT_READY_RUNTIME_STATUS: RuntimeStatus = {
  executionMode: "docker",
  authRequired: false,
  provider: {
    id: "gemini",
    displayName: "Google Gemini",
    apiKeyConfigured: true,
  },
  containerRuntime: {
    configuredRuntime: "auto",
    selectedRuntime: null,
    image: "ghcr.io/jqcvsc/nanogem-sandbox:latest",
    user: "1000:1000",
    network: "none",
    networkEnabled: false,
    executionMode: "docker",
    cpus: "1.0",
    memory: "512m",
    pidsLimit: 64,
    readOnly: true,
    available: false,
    imagePresent: false,
    error: "Neither Docker nor Podman is available on PATH.",
    remediation: "Install Docker Desktop or Podman and start the container daemon.",
  },
  docker: null,
};

let tmpBuildDir: string;
let AppComponent: React.FC<any>;
let INITIAL_APP_TAB: string;
let HomeDashboardComponent: React.FC<any>;

before(async () => {
  tmpBuildDir = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-ui-test-"));
  const outfile = path.join(tmpBuildDir, "app.mjs");
  const entry = path.join(tmpBuildDir, "entry.ts");

  await fs.writeFile(
    entry,
    `export { default as App, INITIAL_APP_TAB } from ${JSON.stringify(
      path.resolve(process.cwd(), "src", "App.tsx")
    )};
export { HomeDashboard } from ${JSON.stringify(
      path.resolve(process.cwd(), "src", "components", "HomeDashboard.tsx")
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
        name: "externalize-node-modules-as-file-urls",
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
  INITIAL_APP_TAB = mod.INITIAL_APP_TAB;
  HomeDashboardComponent = mod.HomeDashboard;
});

after(async () => {
  if (tmpBuildDir) {
    await fs.rm(tmpBuildDir, { recursive: true, force: true });
  }
});

test("initial app view is Home with navigation including Home, Agent, Files, Memory, Review, More", async () => {
  assert.equal(INITIAL_APP_TAB, "home");

  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  try {
    await act(async () => {
      root.render(
        React.createElement(AppComponent, {
          skipInitialFetch: true,
          initialRuntimeStatus: READY_RUNTIME_STATUS,
          initialProjects: [SAMPLE_PROJECT],
          initialProjectId: SAMPLE_PROJECT.id,
          initialSessions: [SAMPLE_SESSION],
          initialActiveSessionId: SAMPLE_SESSION.id,
        })
      );
    });

    const text = container.textContent;
    assert.match(text, /Build with Gemini\. Execute inside a boundary\./);
    assert.match(text, /Open Agent/);
    assert.match(text, /Browse Files/);
    assert.match(text, /Review Changes/);
    assert.match(text, /Instructions & Memory/);
    assert.match(text, /Get started/);
    assert.doesNotMatch(text, /What are you building today\?/);

    for (const label of ["Home", "Agent", "Files", "Memory", "Review", "More"]) {
      findButtonByText(container, label);
    }

    const homeNavButton = findButtonByText(container, "Home");
    assert.equal(homeNavButton.getAttribute("aria-current"), "page");

    assert.equal(findByTestId(container, "home-active-project").textContent.includes("alpha-service"), true);
    assert.equal(
      findByTestId(container, "home-active-session").textContent.includes("Auth Refactor Investigation"),
      true
    );
    assert.match(findByTestId(container, "home-runtime-provider").textContent, /Docker v27\.5\.1/);
    assert.match(text, /Containerized/);
    assert.match(text, /Disabled \(none\)/);
    assert.match(findByTestId(container, "home-safe-execution-note").textContent, /isolated sandbox container/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test("clicking Open Agent shows Agent Chat and clicking NanoGem logo returns to Home", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  try {
    await act(async () => {
      root.render(
        React.createElement(AppComponent, {
          skipInitialFetch: true,
          initialRuntimeStatus: READY_RUNTIME_STATUS,
          initialProjects: [SAMPLE_PROJECT],
          initialProjectId: SAMPLE_PROJECT.id,
          initialSessions: [SAMPLE_SESSION],
          initialActiveSessionId: SAMPLE_SESSION.id,
        })
      );
    });

    const openAgentBtn = findButtonByText(container, "Open Agent");
    await act(async () => {
      openAgentBtn.click();
    });

    assert.match(container.textContent, /What are you building today\?/);
    assert.doesNotMatch(container.textContent, /Build with Gemini\. Execute inside a boundary\./);

    const agentNavBtn = findButtonByText(container, "Agent");
    assert.equal(agentNavBtn.getAttribute("aria-current"), "page");

    const logoBtn = collectElements(container).find(
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "NanoGem Home"
    );
    assert.ok(logoBtn, "Expected NanoGem logo button with aria-label='NanoGem Home'");

    await act(async () => {
      logoBtn.click();
    });

    assert.match(container.textContent, /Build with Gemini\. Execute inside a boundary\./);
    assert.equal(findButtonByText(container, "Home").getAttribute("aria-current"), "page");
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test("chat messages persist while switching Home -> Agent -> Files -> Home -> Agent", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const existingMessages: ChatMessage[] = [
    {
      id: "m-1",
      role: "user",
      content: "Check package.json scripts and verify tests pass.",
      timestamp: "10:00",
    },
    {
      id: "m-2",
      role: "assistant",
      content: "Verified package.json and ran the full test suite cleanly.",
      timestamp: "10:01",
    },
  ];

  try {
    await act(async () => {
      root.render(
        React.createElement(AppComponent, {
          skipInitialFetch: true,
          initialMessages: existingMessages,
          initialRuntimeStatus: READY_RUNTIME_STATUS,
          initialProjects: [SAMPLE_PROJECT],
          initialProjectId: SAMPLE_PROJECT.id,
          initialSessions: [SAMPLE_SESSION],
          initialActiveSessionId: SAMPLE_SESSION.id,
        })
      );
    });

    // Starts on Home even when conversation history exists
    assert.match(container.textContent, /Build with Gemini\. Execute inside a boundary\./);
    assert.match(container.textContent, /2 messages in chat/);

    // Switch to Agent Chat
    await act(async () => {
      findButtonByText(container, "Open Agent").click();
    });
    assert.match(container.textContent, /Check package\.json scripts and verify tests pass\./);
    assert.match(container.textContent, /Verified package\.json and ran the full test suite cleanly\./);

    // Switch to Files
    await act(async () => {
      findButtonByText(container, "Files").click();
    });
    assert.doesNotMatch(container.textContent, /Check package\.json scripts and verify tests pass\./);

    // Return Home via Logo
    const logoBtn = collectElements(container).find(
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "NanoGem Home"
    );
    assert.ok(logoBtn);
    await act(async () => {
      logoBtn.click();
    });
    assert.match(container.textContent, /2 messages in chat/);

    // Return to Agent Chat: messages must still be intact
    await act(async () => {
      findButtonByText(container, "Open Agent").click();
    });
    assert.match(container.textContent, /Check package\.json scripts and verify tests pass\./);
    assert.match(container.textContent, /Verified package\.json and ran the full test suite cleanly\./);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test("runtime-not-ready state is visible on Home with remediation and Setup & Status action", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  try {
    await act(async () => {
      root.render(
        React.createElement(AppComponent, {
          skipInitialFetch: true,
          initialRuntimeStatus: NOT_READY_RUNTIME_STATUS,
          initialProjects: [SAMPLE_PROJECT],
          initialProjectId: SAMPLE_PROJECT.id,
          initialSessions: [SAMPLE_SESSION],
          initialActiveSessionId: SAMPLE_SESSION.id,
        })
      );
    });

    const badge = findByTestId(container, "home-readiness-badge");
    assert.match(badge.textContent, /Runtime Not Ready/);
    assert.doesNotMatch(badge.textContent, /Docker Ready|Podman Ready/);

    const warning = findByTestId(container, "home-runtime-warning");
    assert.match(warning.textContent, /Container runtime unavailable/);
    assert.match(warning.textContent, /Neither Docker nor Podman is available on PATH\./);
    assert.match(warning.textContent, /Install Docker Desktop or Podman/);

    await act(async () => {
      findButtonByText(warning, "Setup & Status").click();
    });

    assert.match(container.textContent, /NanoGem Readiness & Security Posture/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test("HomeDashboard updates project and session labels without stale state", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const secondSession: SessionSummary = {
    id: "sess-2",
    projectId: SECOND_PROJECT.id,
    title: "Queue Retry Hardening",
    channel: "browser",
    externalChatId: null,
    model: "gemini-3.6-flash",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };

  try {
    await act(async () => {
      root.render(
        React.createElement(HomeDashboardComponent, {
          runtimeStatus: READY_RUNTIME_STATUS,
          activeProject: SAMPLE_PROJECT,
          activeProjectId: SAMPLE_PROJECT.id,
          activeSession: SAMPLE_SESSION,
          activeSessionId: SAMPLE_SESSION.id,
          messageCount: 1,
          onSelectTab: () => {},
          onTryPrompt: () => {},
        })
      );
    });

    assert.match(findByTestId(container, "home-active-project").textContent, /alpha-service/);
    assert.match(
      findByTestId(container, "home-active-session").textContent,
      /Auth Refactor Investigation/
    );

    await act(async () => {
      root.render(
        React.createElement(HomeDashboardComponent, {
          runtimeStatus: READY_RUNTIME_STATUS,
          activeProject: SECOND_PROJECT,
          activeProjectId: SECOND_PROJECT.id,
          activeSession: secondSession,
          activeSessionId: secondSession.id,
          messageCount: 0,
          onSelectTab: () => {},
          onTryPrompt: () => {},
        })
      );
    });

    const projectText = findByTestId(container, "home-active-project").textContent;
    const sessionText = findByTestId(container, "home-active-session").textContent;
    assert.match(projectText, /beta-worker/);
    assert.doesNotMatch(projectText, /alpha-service/);
    assert.match(sessionText, /Queue Retry Hardening/);
    assert.doesNotMatch(sessionText, /Auth Refactor Investigation/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test("clicking a Get started example prompt opens Agent Chat with the prompt loaded", async () => {
  const dom = installFakeDom();
  const container = dom.doc.createElement("div");
  dom.doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  try {
    await act(async () => {
      root.render(
        React.createElement(AppComponent, {
          skipInitialFetch: true,
          initialRuntimeStatus: READY_RUNTIME_STATUS,
          initialProjects: [SAMPLE_PROJECT],
          initialProjectId: SAMPLE_PROJECT.id,
          initialSessions: [SAMPLE_SESSION],
          initialActiveSessionId: SAMPLE_SESSION.id,
        })
      );
    });

    const starterBtn = findButtonByText(
      container,
      "Inspect repository files and summarize architecture"
    );
    await act(async () => {
      starterBtn.click();
    });

    assert.match(container.textContent, /What are you building today\?/);
    const textarea = collectElements(container).find((el) => el.tagName === "TEXTAREA");
    assert.ok(textarea, "Expected Agent Chat prompt textarea");
    assert.equal(textarea.value, "Inspect repository files and summarize architecture");
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});
