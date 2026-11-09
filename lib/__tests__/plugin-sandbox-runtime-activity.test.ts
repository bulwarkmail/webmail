/**
 * Input inside a plugin frame never reaches the host window, so the idle
 * timeout signed users out while they worked in a plugin page or dialog. The
 * runtime reports trusted input in its frame through a port it hands the
 * host with 'sandbox-ready', before any plugin code runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';

const HOST_ORIGIN = window.location.origin;

let hostWindow: { postMessage: ReturnType<typeof vi.fn> };
const realParent = Object.getOwnPropertyDescriptor(window, 'parent');
const ports: MessagePort[] = [];

beforeEach(() => {
  // The runtime keeps its host binding and boot flag at module scope.
  vi.resetModules();
  hostWindow = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { configurable: true, get: () => hostWindow as unknown as Window });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const port of ports.splice(0)) port.close();
  if (realParent) Object.defineProperty(window, 'parent', realParent);
});

/**
 * Mount the runtime; returns the input listeners it put on the window and
 * the reports that reach the host's end of the port. jsdom can't make a
 * trusted event, so trusted input calls the listeners directly.
 */
async function mountRuntime() {
  const added = new Map<string, EventListener>();
  const addEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type !== 'message') added.set(type, listener as EventListener);
    addEventListener(type, listener, options);
  });
  const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
  render(React.createElement(SandboxRuntime));

  const [msg, target, transfer] = hostWindow.postMessage.mock.calls[0];
  expect(msg).toEqual({ type: 'sandbox-ready' });
  expect(target).toBe(HOST_ORIGIN);
  const port = (transfer as MessagePort[])[0];
  ports.push(port);
  const reports = vi.fn();
  port.onmessage = reports;

  const trusted = (type: string) => added.get(type)?.({ type, isTrusted: true } as unknown as Event);
  return { added, reports, trusted };
}

const delivered = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('plugin sandbox runtime activity reports', () => {
  it('listens for the input the host window counts, and not for focus', async () => {
    const { added } = await mountRuntime();
    expect([...added.keys()].sort()).toEqual(['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel']);
  });

  it('reports trusted input to the host through the port', async () => {
    const { reports, trusted } = await mountRuntime();
    trusted('keydown');
    await delivered();
    expect(reports).toHaveBeenCalledTimes(1);
    // Nothing goes to the window a plugin can post to as well.
    expect(hostWindow.postMessage).toHaveBeenCalledTimes(1);
  });

  it('reports at most once per ACTIVITY_REPORT_MS', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { reports, trusted } = await mountRuntime();
    const { ACTIVITY_REPORT_MS } = await import('@/lib/plugin-sandbox/runtime');

    trusted('pointerdown');
    now.mockReturnValue(1_000_000 + ACTIVITY_REPORT_MS - 1);
    trusted('pointermove');
    trusted('wheel');
    await delivered();
    expect(reports).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + ACTIVITY_REPORT_MS);
    trusted('touchstart');
    await delivered();
    expect(reports).toHaveBeenCalledTimes(2);
  });

  it('does not report input a script dispatched, or focus', async () => {
    const { reports } = await mountRuntime();
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.pointerDown(document.body);
    fireEvent.focus(window);
    await delivered();
    expect(reports).not.toHaveBeenCalled();
  });
});
