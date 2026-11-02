import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOffers, FakeIframeSlot, offerSlots, slotProps } from './fake-plugin-offer';
import { requestPanel, resetPanelRequests } from '@/lib/plugin-sandbox/panel-requests';
import { setActionDispatcher } from '@/lib/plugin-sandbox/actions';
import { deregister, register, type ActivePlugin } from '@/lib/plugin-sandbox/registry';
import { registerShortcuts } from '@/lib/plugin-sandbox/shortcuts';

// The plugin side panel of Calendar, Contacts, Files and Settings
// (app-side-panel): its button, folding, width, the overlay on a narrow
// view, focus requests, the plugin's own requests, and the dialog where it
// can't dock.

vi.mock('@/components/plugins/plugin-iframe-slot', () => ({ PluginIframeSlot: FakeIframeSlot }));
const device = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-media-query')>()),
  useIsMobile: () => device.isMobile,
}));

const { useAppSidePanel, AppSidePanelPhoneButton, APP_SIDE_PANEL_COLLAPSED_KEY, APP_SIDE_PANEL_WIDTH_KEY } = await import('../app-side-panel');
const { EmbeddedContext } = await import('@/hooks/use-is-embedded');
import type { AppSidePanelContext, AppSidePanelViewName } from '@/lib/plugin-sandbox/assistant/f.types';

// One ResizeObserver per row; tests set the row's width with resizeRow().
let observed: ((width: number) => void) | null = null;
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() { observed = (width) => this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  disconnect() { observed = null; }
  unobserve() {}
}
const resizeRow = (width: number) => act(() => observed?.(width));

const EVENT_CONTEXT: AppSidePanelContext = { page: { id: 'reading', label: 'Reading' } };

function Harness({ view = 'settings', context = EVENT_CONTEXT, dock = true, hidden = false, onOpen }: { view?: AppSidePanelViewName; context?: AppSidePanelContext; dock?: boolean; hidden?: boolean; onOpen?: () => void }) {
  const panel = useAppSidePanel({ view, context, dock, hidden, onOpen });
  return (
    <div>
      <div data-testid="toolbar">{panel.toggle}</div>
      <div ref={panel.rowRef} data-testid="row">{panel.panel}</div>
      <div data-testid="phone-header"><AppSidePanelPhoneButton /></div>
    </div>
  );
}

const toggle = () => screen.getByRole('button', { name: 'plugin_panel' });
const frame = () => screen.queryByTestId('slot-app-side-panel');

beforeEach(() => {
  device.isMobile = false;
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  clearOffers();
  resetPanelRequests();
  setActionDispatcher(null);
  vi.unstubAllGlobals();
});

describe('app-side-panel', () => {
  it('shows nothing without a plugin offering it', () => {
    render(<Harness />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('[data-app-side-panel]')).toBeNull();
  });

  it('opens and folds from its button, and the frame gets the view, its context and a focus request', () => {
    offerSlots('p1', ['app-side-panel'], { fill: ['app-side-panel'] });
    render(<Harness />);
    // Open until the user folds it (the plugin didn't ask to start folded).
    expect(frame()).not.toBeNull();
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    // One name; aria-pressed says whether it is open.
    expect(toggle()).toHaveAttribute('title', 'plugin_panel');
    expect(screen.getByRole('complementary', { name: 'p1' })).toContainElement(frame());
    expect(slotProps(frame()!)).toEqual({ view: 'settings', context: EVENT_CONTEXT, focusRequest: 0 });
    expect(frame()!.getAttribute('data-fill')).toBe('true');

    fireEvent.click(toggle());
    expect(frame()).toBeNull();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(toggle()).toHaveAccessibleName('plugin_panel');
    expect(localStorage.getItem(APP_SIDE_PANEL_COLLAPSED_KEY)).toBe('1');

    // Opening asks the plugin to take the focus.
    fireEvent.click(toggle());
    expect(slotProps(frame()!).focusRequest).toBe(1);
    expect(localStorage.getItem(APP_SIDE_PANEL_COLLAPSED_KEY)).toBe('0');
  });

  it('starts folded when the plugin asks, until the user opens it', () => {
    offerSlots('p1', ['app-side-panel'], { startFolded: ['app-side-panel'] });
    const { unmount } = render(<Harness />);
    expect(frame()).toBeNull();
    fireEvent.click(toggle());
    expect(frame()).not.toBeNull();
    unmount();
    // The choice holds in the next view.
    render(<Harness view="calendar" context={{}} />);
    expect(frame()).not.toBeNull();
  });

  it('keeps its width between 200 and 500 px, and remembers it', () => {
    offerSlots('p1', ['app-side-panel']);
    localStorage.setItem(APP_SIDE_PANEL_WIDTH_KEY, '900');
    render(<Harness />);
    const panel = document.querySelector<HTMLElement>('[data-app-side-panel]')!;
    expect(panel.style.width).toBe('500px');
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-valuemin', '200');
    expect(handle).toHaveAttribute('aria-valuemax', '500');
    fireEvent.doubleClick(handle);
    expect(panel.style.width).toBe('280px');
    expect(localStorage.getItem(APP_SIDE_PANEL_WIDTH_KEY)).toBe('280');
  });

  it('folds when the view gets too narrow, and lies over it when opened anyway', () => {
    offerSlots('p1', ['app-side-panel']);
    render(<Harness />);
    resizeRow(1200);
    expect(document.querySelector('[data-app-side-panel]')).toHaveAttribute('data-app-side-panel', 'docked');
    resizeRow(600);
    expect(frame()).toBeNull();
    fireEvent.click(toggle());
    const panel = document.querySelector<HTMLElement>('[data-app-side-panel]')!;
    expect(panel).toHaveAttribute('data-app-side-panel', 'overlay');
    expect(panel.className).toContain('absolute');
    // No drag handle over the view.
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('answers the plugin\'s open, close and toggle requests', () => {
    offerSlots('p1', ['app-side-panel'], { startFolded: ['app-side-panel'] });
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    expect(frame()).toBeNull();

    let answer: boolean | null = null;
    act(() => { answer = requestPanel('p1', 'app-side-panel', 'open', undefined); });
    expect(answer).toBe(true);
    expect(frame()).not.toBeNull();
    expect(slotProps(frame()!).focusRequest).toBe(1);
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() => { answer = requestPanel('p1', 'app-side-panel', 'toggle', undefined); });
    expect(answer).toBe(false);
    expect(frame()).toBeNull();

    act(() => { answer = requestPanel('p1', 'app-side-panel', 'close', undefined); });
    expect(answer).toBe(false);
    // The reader's panel is not this one.
    act(() => { answer = requestPanel('p1', 'email-detail-sidebar', 'open', undefined); });
    expect(answer).toBeNull();
  });

  it('is not there in the Pro shell\'s panes', () => {
    offerSlots('p1', ['app-side-panel']);
    render(<EmbeddedContext.Provider value><Harness /></EmbeddedContext.Provider>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(requestPanel('p1', 'app-side-panel', 'open', undefined)).toBeNull();
  });

  it('asks the plugin for its dialog on a phone, with the view and what it shows', async () => {
    device.isMobile = true;
    const dispatch = vi.fn().mockResolvedValue(undefined);
    setActionDispatcher(dispatch);
    offerSlots('p1', ['app-side-panel']);
    render(<Harness view="calendar" context={{ selectedCount: 2 }} />);
    // No panel and no toolbar button; the phone header has the button.
    expect(screen.queryByTestId('toolbar')!.childElementCount).toBe(0);
    expect(document.querySelector('[data-app-side-panel]')).toBeNull();
    const phone = screen.getByRole('button', { name: 'plugin_panel_show' });
    expect(screen.getByTestId('phone-header')).toContainElement(phone);

    fireEvent.click(phone);
    expect(dispatch).toHaveBeenCalledWith('p1', 'app-side-panel', 'open', { view: 'calendar', context: { selectedCount: 2 } });

    // The plugin's own open request goes the same way; the panel stays closed.
    let answer: boolean | null = null;
    act(() => { answer = requestPanel('p1', 'app-side-panel', 'toggle', undefined); });
    expect(answer).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(2);
    act(() => { answer = requestPanel('p1', 'app-side-panel', 'close', undefined); });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('uses the dialog where the view says it has no room (Settings below 1024 px)', () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    setActionDispatcher(dispatch);
    offerSlots('p1', ['app-side-panel']);
    const { unmount } = render(<Harness dock={false} />);
    expect(screen.getByTestId('toolbar').childElementCount).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'plugin_panel_show' }));
    expect(dispatch).toHaveBeenCalledWith('p1', 'app-side-panel', 'open', { view: 'settings', context: EVENT_CONTEXT });
    // Leaving the view takes the phone header's button away.
    unmount();
    render(<div><AppSidePanelPhoneButton /></div>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it("shows no button and no panel when the plugin's shouldShow says no", async () => {
    const evaluateShouldShow = vi.fn(async () => false);
    register({
      plugin: { id: 'p2', name: 'P2', permissions: ['ui:side-panel'], managed: true },
      code: '', tier: 'untrusted', background: { evaluateShouldShow },
      slotOffers: [{ name: 'app-side-panel', order: 100, hasShouldShow: true }], hookDisposables: [],
    } as unknown as ActivePlugin);
    try {
      render(<Harness view="calendar" context={{ selectedCount: 1 }} />);
      await waitFor(() => expect(evaluateShouldShow).toHaveBeenCalledWith('app-side-panel', { view: 'calendar', context: {} }));
      expect(screen.queryByRole('button')).toBeNull();
      expect(document.querySelector('[data-app-side-panel]')).toBeNull();
      expect(requestPanel('p2', 'app-side-panel', 'open', undefined)).toBeNull();
      // It says yes: the button comes.
      evaluateShouldShow.mockResolvedValue(true);
      cleanup();
      render(<Harness view="calendar" context={{ selectedCount: 2 }} />);
      expect(await screen.findByRole('button', { name: 'plugin_panel' })).toBeTruthy();
    } finally {
      deregister('p2');
    }
  });

  it('steps aside while the view hides it, without changing the choice the other views keep', () => {
    offerSlots('p1', ['app-side-panel']);
    const onOpen = vi.fn();
    const { rerender } = render(<Harness hidden onOpen={onOpen} />);
    expect(frame()).toBeNull();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem(APP_SIDE_PANEL_COLLAPSED_KEY)).toBeNull();
    rerender(<Harness hidden={false} onOpen={onOpen} />);
    expect(frame()).not.toBeNull();
    // Opening it while hidden asks the view to make room.
    rerender(<Harness hidden onOpen={onOpen} />);
    fireEvent.click(toggle());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('grows only as far as the view keeps its room, so resizing never folds it', () => {
    offerSlots('p1', ['app-side-panel']);
    render(<Harness />);
    resizeRow(900);
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-valuemax', '420');
    handle.focus();
    for (let i = 0; i < 30; i++) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    const panel = document.querySelector<HTMLElement>('[data-app-side-panel]')!;
    expect(panel).toHaveAttribute('data-app-side-panel', 'docked');
    expect(panel.style.width).toBe('420px');
    // The handle is still there and keeps the focus.
    expect(document.activeElement).toBe(handle);
    // A drag stops at the same place.
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(document, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 100, pointerId: 1 });
    expect(document.querySelector('[data-app-side-panel]')).toHaveAttribute('data-app-side-panel', 'docked');
    expect(document.querySelector<HTMLElement>('[data-app-side-panel]')!.style.width).toBe('420px');
  });

  it('gives the focus back to its button when it closes with the focus inside', async () => {
    offerSlots('p1', ['app-side-panel']);
    render(<Harness />);
    const panel = screen.getByRole('complementary');
    panel.tabIndex = -1;
    panel.focus();
    act(() => { requestPanel('p1', 'app-side-panel', 'close', undefined); });
    await waitFor(() => expect(document.activeElement).toBe(toggle()));
  });

  it("names the plugin's panel shortcut in the button's title", () => {
    offerSlots('p1', ['app-side-panel']);
    const dispose = registerShortcuts({ pluginId: 'p1', invokeHook: vi.fn() } as never, [{ id: 'toggle-panel', keys: 'Alt+A', label: 'Toggle' }]);
    try {
      render(<Harness />);
      expect(toggle()).toHaveAttribute('title', 'plugin_panel (Alt+A)');
      expect(toggle()).toHaveAttribute('aria-keyshortcuts', 'Alt+A');
      expect(toggle()).toHaveAccessibleName('plugin_panel');
    } finally {
      dispose();
    }
  });
});
