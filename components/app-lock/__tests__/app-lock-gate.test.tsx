import { act, useEffect, type ReactNode } from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToPipeableStream } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";

/**
 * The gate against real React: the server's stream, then hydration. The controller is
 * a stand-in, since what's tested here is what the gate does with a hold and a phase
 * (lib/app-lock/__tests__/controller.test.ts tests the decisions themselves).
 */
const lock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    phase: "open" as string,
    hold: null as { promise: Promise<void>; release: () => void } | null,
    setPhase(next: string) {
      state.phase = next;
      for (const listener of [...listeners]) listener();
    },
    takeHold() {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.hold = { promise, release };
    },
    open() {
      const held = state.hold;
      state.hold = null;
      state.setPhase("open");
      held?.release();
    },
    listeners,
  };
  return state;
});

vi.mock("@/lib/app-lock/controller", () => ({
  appLockHold: () => lock.hold?.promise ?? null,
  bootAppLock: () => {},
  getAppLockPhase: () => lock.phase,
  recheckAppLockSetup: () => {},
  startAppLock: () => () => {},
  subscribeAppLockPhase: (listener: () => void) => {
    lock.listeners.add(listener);
    return () => lock.listeners.delete(listener);
  },
  takeDraftsSavedNotice: () => false,
}));
vi.mock("../lock-screen", () => ({
  LockScreen: ({ phase }: { phase: string }) => <div data-testid="lock-screen">{phase}</div>,
}));

import { AppLockGate } from "../app-lock-gate";

/** Well over the size at which React moves a Suspense boundary out of the shell. */
const ROWS = Array.from({ length: 600 }, (_, i) => `row ${i} of a page skeleton, as long as a real one`);

let effects = 0;

function App() {
  useEffect(() => {
    effects += 1;
  }, []);
  return <main data-testid="app">{ROWS.map((row) => <p key={row}>{row}</p>)}</main>;
}

const page = (app: ReactNode = <App />) => <AppLockGate>{app}</AppLockGate>;

/** What the server sends, first byte to last, as the page's real stream does. */
async function stream(tree: ReactNode): Promise<string> {
  vi.stubGlobal("window", undefined);
  try {
    return await new Promise<string>((resolve, reject) => {
      let html = "";
      const out = new PassThrough();
      out.on("data", (chunk) => { html += chunk; });
      out.on("end", () => resolve(html));
      const { pipe } = renderToPipeableStream(tree, {
        onShellReady: () => pipe(out),
        onError: reject,
      });
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The markup to hydrate: the gate alone, since a test can't hydrate a whole document. */
const serverHtml = () => stream(page());

/**
 * A whole page, <html> and all, as the root layout renders it. It has to be: React only
 * moves a boundary out of a shell that has a document around it.
 */
const serverDocument = () => stream(<html><head /><body>{page()}</body></html>);

let root: Root | null = null;
let recoverable: unknown[] = [];

/** Hydrates the server's markup and lets everything that can finish, finish. */
async function hydrate(html: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  await act(async () => {
    root = hydrateRoot(container, page(), { onRecoverableError: (e) => { recoverable.push(e); } });
  });
  return container;
}

const lockScreen = () => document.querySelector('[data-testid="lock-screen"]');

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  lock.phase = "open";
  lock.hold = null;
  lock.listeners.clear();
  effects = 0;
  recoverable = [];
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("what the server sends", () => {
  it("has the app in the shell, not in a hidden segment a script reveals later", async () => {
    const html = await serverDocument();
    expect(html).toContain("row 0 of a page skeleton");
    expect(html).not.toContain('<template id="B:');
    expect(html).not.toMatch(/<div hidden id="S:/);
    expect(html).not.toContain("$RC");
  });

  it("the page is on screen as soon as its bytes are, before any script ran", async () => {
    const parsed = new DOMParser().parseFromString(await serverDocument(), "text/html");
    const app = parsed.querySelector('[data-testid="app"]');
    expect(app).not.toBeNull();
    expect(app?.closest("[hidden]")).toBeNull();
  });
});

describe("with no lock", () => {
  it("hydrates the server's markup where it is, with no mismatch and the effects run", async () => {
    const html = await serverHtml();
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const fromServer = container.querySelector('[data-testid="app"]');
    await act(async () => {
      root = hydrateRoot(container, page(), { onRecoverableError: (e) => { recoverable.push(e); } });
    });
    expect(recoverable).toEqual([]);
    expect(container.querySelector('[data-testid="app"]')).toBe(fromServer);
    expect(effects).toBe(1);
    expect(lockScreen()).toBeNull();
  });
});

describe("while the lock holds", () => {
  it("nothing below hydrates: no effect runs, and the server's markup stays", async () => {
    const html = await serverHtml();
    lock.phase = "locked";
    lock.takeHold();
    const container = await hydrate(html);
    expect(effects).toBe(0);
    expect(container.querySelector('[data-testid="app"]')).not.toBeNull();
    expect(lockScreen()?.textContent).toBe("locked");
    expect(recoverable).toEqual([]);
  });

  it("an unlock hydrates that same markup in this document", async () => {
    const html = await serverHtml();
    lock.phase = "locked";
    lock.takeHold();
    const container = await hydrate(html);
    const fromServer = container.querySelector('[data-testid="app"]');
    await act(async () => lock.open());
    expect(effects).toBe(1);
    expect(container.querySelector('[data-testid="app"]')).toBe(fromServer);
    expect(lockScreen()).toBeNull();
    expect(recoverable).toEqual([]);
  });

  it("a phase change shows on the lock screen and leaves the held app alone", async () => {
    const html = await serverHtml();
    lock.phase = "checking";
    lock.takeHold();
    const container = await hydrate(html);
    const fromServer = container.querySelector('[data-testid="app"]');
    expect(lockScreen()).toBeNull();
    await act(async () => lock.setPhase("locked"));
    expect(lockScreen()?.textContent).toBe("locked");
    expect(effects).toBe(0);
    expect(container.querySelector('[data-testid="app"]')).toBe(fromServer);
    await act(async () => lock.setPhase("locked-stay"));
    expect(lockScreen()?.textContent).toBe("locked-stay");
    expect(effects).toBe(0);
  });
});

describe("once it has hydrated", () => {
  it("a late hold takes the app away and the lock screen still comes up, and an unlock brings it back", async () => {
    const container = await hydrate(await serverHtml());
    expect(effects).toBe(1);
    await act(async () => {
      lock.takeHold();
      lock.setPhase("locked");
    });
    expect(lockScreen()?.textContent).toBe("locked");
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
    await act(async () => lock.open());
    expect(lockScreen()).toBeNull();
    expect(container.querySelector('[data-testid="app"]')).not.toBeNull();
  });

  it("a page that couldn't reload has the app gone from the screen", async () => {
    const container = await hydrate(await serverHtml());
    await act(async () => lock.setPhase("locked-stay"));
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
    expect(lockScreen()?.textContent).toBe("locked-stay");
  });
});
