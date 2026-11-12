// A plugin frame may ask the host to draw a dropdown for it (the UI kit's Combobox). The host
// draws the list in its own document, with the plugin's texts. The rule these tests hold:
//
//   While a dialog is open that the plugin's frame is not inside, the host draws no dropdown for
//   that frame, and closes one that is already open.
//
// So a list of a plugin's texts never lies over a question the host asks (forward approval,
// connect an account, a password prompt's note). A Combobox inside a plugin's own dialog keeps
// working. The tests look at what is in the document, not at stacking numbers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { InstalledPlugin } from '@/lib/plugin-types';

// A translator that shows the values it is given, so a name passed to a message is in the document.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Webmail' }) }));

const plugins = new Map<string, InstalledPlugin>();
vi.mock('@/lib/plugin-sandbox/registry', () => ({
  get: (id: string) => {
    const plugin = plugins.get(id);
    return plugin && {
      plugin,
      code: '',
      tier: 'untrusted',
      background: { evaluateShouldShow: async () => true },
      slotOffers: [
        { name: 'plugin-dialog', hasShouldShow: false, order: 100, fill: true },
        { name: 'app-top-banner', hasShouldShow: false, order: 100 },
      ],
    };
  },
}));

type DropdownMsg = Record<string, unknown>;
type SlotOptions = { plugin: InstalledPlugin; slot: string; hostContainer: HTMLElement; onFloatingDropdown: (msg: DropdownMsg) => void };
type FakeInstance = { sendFloatingDropdownEvent: ReturnType<typeof vi.fn> };
const createSlotInstance = vi.fn((opts: SlotOptions) => {
  // The real instance puts its iframe into the container; the dropdown is placed from its rect.
  opts.hostContainer.appendChild(document.createElement('iframe'));
  return { destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn(), sendFloatingDropdownEvent: vi.fn(), initPromise: Promise.resolve() };
});
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: (opts: SlotOptions) => createSlotInstance(opts),
}));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

import { PluginDialogHost } from '@/components/plugins/plugin-dialog-host';
import { PluginIframeSlot, placeFloatingDropdown, DROPDOWN_MAX_HEIGHT } from '@/components/plugins/plugin-iframe-slot';
import { PluginConnectDialog } from '@/components/plugins/plugin-connect-dialog';
import { PluginConsentDialog } from '@/components/plugins/plugin-consent-dialog';
import { Dialog } from '@/components/ui/dialog';
import { awaitCustomDialog, awaitDialog, awaitPrompt, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';
import { cancelConnectFor, requestConnect } from '@/lib/plugin-sandbox/connect-dialog';
import { head as consentHead, requestConsent, resolveHead as resolveConsent } from '@/lib/plugin-sandbox/consent';

function plugin(perms: string[], id = 'helper', name = 'Helpful plugin'): InstalledPlugin {
  const p: InstalledPlugin = {
    id, name, version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  plugins.set(id, p);
  return p;
}

/** What a frame posts to open a dropdown (after the host's own checks on the message). */
const OPEN: DropdownMsg = {
  type: 'floating-dropdown-open', id: 'list-1',
  rect: { left: 0, top: 0, bottom: 1, width: 448, height: 1 },
  options: [{ value: 'a', label: 'First choice of the plugin' }, { value: 'b', label: 'Second choice of the plugin' }],
  selectedValues: [], highlightedIndex: -1,
};

/** The lists the host has drawn for the plugin. */
function pluginLists(): Element[] {
  return [...document.querySelectorAll('[role="listbox"]')].filter((list) => list.textContent?.includes('First choice of the plugin'));
}

function frameCall(slot: string, pluginId = 'helper'): { opts: SlotOptions; instance: FakeInstance } {
  const index = createSlotInstance.mock.calls.findIndex(([opts]) => opts.slot === slot && opts.plugin.id === pluginId);
  if (index < 0) throw new Error(`no frame for ${slot}`);
  return { opts: createSlotInstance.mock.calls[index][0], instance: createSlotInstance.mock.results[index].value as FakeInstance };
}

function frameOptions(slot: string, pluginId = 'helper'): SlotOptions {
  return frameCall(slot, pluginId).opts;
}

/** A question the host asks about the plugin, as host-api-forward.ts does before a first forward. */
function askHostQuestion() {
  act(() => {
    void awaitDialog({
      pluginId: 'helper', kind: 'confirm',
      title: 'Let Helpful plugin forward mail to someone@example.net?',
      message: 'Helpful plugin wants to forward “Invoice” with its attachments to someone@example.net.',
      confirmLabel: 'Allow and forward',
    });
  });
  const question = screen.getByText('Let Helpful plugin forward mail to someone@example.net?').closest('[role="dialog"]');
  expect(question).toBeTruthy();
}

/** The banner frame of the plugin, mounted and started. */
async function mountBanner(...siblings: React.ReactNode[]) {
  plugin(['ui:app-top-banner']);
  render(
    <>
      <PluginIframeSlot pluginId="helper" slot="app-top-banner" extraProps={{}} />
      {siblings}
    </>,
  );
  await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
}

/** The host's connect dialog, as api.proxy.connect opens it. */
function askToConnect() {
  act(() => {
    void requestConnect({
      pluginId: 'helper', pluginName: 'Helpful plugin', credentialId: 'cloud', mode: 'password',
      spec: { label: 'Cloud', scope: 'user', inject: { type: 'basic' } },
    }).catch(() => {});
  });
  expect(screen.getByRole('dialog', { name: /^title / })).toBeTruthy();
}

/** The host's consent dialog, as enabling a plugin opens it. */
function askForConsent() {
  act(() => { void requestConsent('other', 'Other plugin', ['email:read']); });
  expect(screen.getByRole('dialog', { name: /^title Other plugin/ })).toBeTruthy();
}

beforeEach(() => {
  while (head()) resolveHead(null);
  while (consentHead()) resolveConsent(false);
  cancelConnectFor('helper');
  resetDialogLimits();
  createSlotInstance.mockClear();
  plugins.clear();
  // jsdom has no layout. A frame gets a list only when it shows with a real size, so every
  // frame (and its wrapper) is given a box; everything else stays 0 x 0 at the origin.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const shows = this.tagName === 'IFRAME' || this.matches('[data-plugin-iframe-slot]');
    const box = shows ? { left: 100, top: 100, right: 548, bottom: 400 } : { left: 0, top: 0, right: 0, bottom: 0 };
    return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('a plugin dropdown and the host\'s own dialogs', () => {
  it('draws no dropdown for the frame of a plugin dialog while a host question is open on top of it', async () => {
    plugin(['email:read', 'email:forward']);
    render(<PluginDialogHost />);
    act(() => { void awaitCustomDialog({ pluginId: 'helper', title: 'Mailbox check', message: '', slot: 'plugin-dialog', fill: true }); });
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    askHostQuestion();

    act(() => frameOptions('plugin-dialog').onFloatingDropdown(OPEN));

    expect(pluginLists()).toHaveLength(0);
  });

  it('draws no dropdown for a frame elsewhere on the page (a banner) while a host question is open', async () => {
    await mountBanner(<PluginDialogHost key="host" />);
    askHostQuestion();

    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));

    expect(pluginLists()).toHaveLength(0);
    // The frame hears that its list is closed, so its Select doesn't stay open.
    expect(frameCall('app-top-banner').instance.sendFloatingDropdownEvent).toHaveBeenCalledWith({ type: 'floating-dropdown-dismiss', id: 'list-1' });
  });

  it('closes a dropdown that is already open when a host question opens', async () => {
    await mountBanner(<PluginDialogHost key="host" />);
    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));
    // With no dialog open a banner's Select works.
    expect(pluginLists()).toHaveLength(1);

    askHostQuestion();

    await waitFor(() => expect(pluginLists()).toHaveLength(0));
  });

  // Control: the kit's Select inside a plugin's own dialog keeps working.
  it('still draws the dropdown of a frame inside a plugin dialog', async () => {
    plugin([]);
    render(<PluginDialogHost />);
    act(() => { void awaitCustomDialog({ pluginId: 'helper', title: 'Pick a folder', message: '', slot: 'plugin-dialog' }); });
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());

    act(() => frameOptions('plugin-dialog').onFloatingDropdown(OPEN));

    expect(pluginLists()).toHaveLength(1);
    // Drawn in the plugin dialog's own layer, so a dialog drawn above that one is above the list.
    expect(pluginLists()[0].closest('[data-plugin-dialog-layer]')).not.toBeNull();
  });

  it('draws no dropdown over the host\'s connect dialog, and closes one that was open', async () => {
    await mountBanner(<PluginConnectDialog key="connect" />);
    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));
    expect(pluginLists()).toHaveLength(1);

    askToConnect();
    await waitFor(() => expect(pluginLists()).toHaveLength(0));

    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));
    expect(pluginLists()).toHaveLength(0);
  });

  it('draws no dropdown over the host\'s consent dialog, and closes one that was open', async () => {
    await mountBanner(<PluginConsentDialog key="consent" />);
    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));
    expect(pluginLists()).toHaveLength(1);

    askForConsent();
    await waitFor(() => expect(pluginLists()).toHaveLength(0));

    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));
    expect(pluginLists()).toHaveLength(0);
  });

  it('draws no dropdown over one of the app\'s own dialogs', async () => {
    await mountBanner();
    render(<Dialog isOpen onClose={() => {}} title="Rename folder" />);
    expect(screen.getByRole('dialog', { name: 'Rename folder' })).toBeTruthy();

    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));

    expect(pluginLists()).toHaveLength(0);
  });

  it('keeps the note under a plugin\'s password prompt free: no dropdown for the frame of the dialog under it', async () => {
    plugin([]);
    render(<PluginDialogHost />);
    act(() => { void awaitCustomDialog({ pluginId: 'helper', title: 'Account', message: '', slot: 'plugin-dialog' }); });
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    act(() => frameOptions('plugin-dialog').onFloatingDropdown(OPEN));
    expect(pluginLists()).toHaveLength(1);

    act(() => {
      void awaitPrompt({
        pluginId: 'helper', kind: 'prompt', title: 'Your session has expired', message: '',
        fields: [{ name: 'password', label: 'Password', type: 'password' }],
      });
    });

    expect(screen.getByText(/^password_note /)).toBeTruthy();
    await waitFor(() => expect(pluginLists()).toHaveLength(0));
    act(() => frameOptions('plugin-dialog').onFloatingDropdown(OPEN));
    expect(pluginLists()).toHaveLength(0);
  });

  it('with two plugin dialogs queued, draws the list of the one showing and none once the next one is up', async () => {
    plugin([], 'first', 'First plugin');
    plugin([], 'second', 'Second plugin');
    render(<PluginDialogHost />);
    let answerFirst: Promise<unknown>;
    act(() => {
      answerFirst = awaitCustomDialog({ pluginId: 'first', title: 'First', message: '', slot: 'plugin-dialog' });
      void awaitCustomDialog({ pluginId: 'second', title: 'Second', message: '', slot: 'plugin-dialog' });
    });
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalledTimes(1));
    // The second dialog waits behind the first: nothing covers the first one's frame.
    act(() => frameOptions('plugin-dialog', 'first').onFloatingDropdown(OPEN));
    expect(pluginLists()).toHaveLength(1);

    act(() => resolveHead('done'));
    await answerFirst!;
    await waitFor(() => expect(screen.getByText('Second')).toBeTruthy());

    expect(pluginLists()).toHaveLength(0);
  });

  it('names the plugin in the list\'s label', async () => {
    await mountBanner();
    act(() => frameOptions('app-top-banner').onFloatingDropdown({ ...OPEN, ariaLabel: 'Folder' }));
    expect(pluginLists()[0].getAttribute('aria-label')).toContain('Helpful plugin');
    expect(pluginLists()[0].getAttribute('aria-label')).toContain('Folder');

    act(() => frameOptions('app-top-banner').onFloatingDropdown({ ...OPEN, id: 'list-2' }));
    expect(pluginLists()[0].getAttribute('aria-label')).toContain('Helpful plugin');
  });

  it('names the plugin in the list\'s first row, apart from the plugin\'s options', async () => {
    await mountBanner();
    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));
    const [list] = pluginLists();
    const first = list.firstElementChild!;
    expect(first.getAttribute('role')).toBeNull();
    expect(first.textContent).toBe('from_plugin Helpful plugin');
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(first.querySelector('[role="option"]')).toBeNull();
  });

  it('draws the list under the toasts, whose line names their plugin', async () => {
    await mountBanner();
    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));
    // The toast container stacks at 99999 (components/ui/toast.tsx).
    expect(Number((pluginLists()[0] as HTMLElement).style.zIndex)).toBeLessThan(99999);
  });

  it('draws no list for a frame that is hidden', async () => {
    await mountBanner();
    const frame = document.querySelector<HTMLIFrameElement>('[data-plugin-iframe-slot="helper:app-top-banner"] iframe')!;
    frame.style.visibility = 'hidden';
    act(() => frameOptions('app-top-banner').onFloatingDropdown(OPEN));
    expect(pluginLists()).toHaveLength(0);
  });
});

describe('where the host draws a frame\'s list', () => {
  const viewport = { width: 1400, height: 900 };

  it('keeps the list inside the part of the window the frame shows in, plus the list\'s own height', () => {
    // A frame 600 px tall whose top half is scrolled out of its panel (the panel starts at y = 200).
    const frame = { left: 300, top: -100, right: 800, bottom: 500 };
    const area = { left: 300, top: 200, right: 800, bottom: 500 };
    // An anchor in the hidden part, as wide as the window.
    const place = placeFloatingDropdown({ left: 0, top: 10, bottom: 30, width: 1400, height: 20 }, frame, area, viewport)!;

    expect(place.left).toBeGreaterThanOrEqual(area.left);
    expect(place.left + place.width).toBeLessThanOrEqual(area.right);
    expect(place.maxHeight).toBeLessThanOrEqual(DROPDOWN_MAX_HEIGHT);
    const top = place.top ?? viewport.height - place.bottom! - place.maxHeight;
    expect(top).toBeGreaterThanOrEqual(area.top - place.maxHeight - 4);
    expect(top + place.maxHeight).toBeLessThanOrEqual(area.bottom + place.maxHeight + 4);
  });

  it('opens upward near the bottom of the window and still stays next to the frame', () => {
    const frame = { left: 0, top: 700, right: 400, bottom: 880 };
    const place = placeFloatingDropdown({ left: 20, top: 150, bottom: 170, width: 200, height: 20 }, frame, frame, viewport)!;

    expect(place.top).toBeUndefined();
    // The list's lower edge is just above the anchor, inside the frame.
    const lower = viewport.height - place.bottom!;
    expect(lower).toBeGreaterThanOrEqual(frame.top - 4);
    expect(lower).toBeLessThanOrEqual(frame.bottom);
    expect(place.left).toBe(20);
    expect(place.width).toBe(200);
  });

  it('draws no list for a frame that shows nowhere', () => {
    // Scrolled out of its panel entirely: the shown part is empty.
    const area = { left: 300, top: 200, right: 800, bottom: -100 };
    expect(placeFloatingDropdown({ left: 0, top: 10, bottom: 30, width: 100, height: 20 }, { left: 300, top: -700 }, area, viewport)).toBeNull();
    // A frame 0 px tall, or 0 px wide, shows nothing either.
    expect(placeFloatingDropdown({ left: 0, top: 0, bottom: 0, width: 100, height: 0 }, { left: 0, top: 0 }, { left: 0, top: 0, right: 1400, bottom: 0 }, viewport)).toBeNull();
    expect(placeFloatingDropdown({ left: 0, top: 0, bottom: 10, width: 100, height: 10 }, { left: 0, top: 0 }, { left: 0, top: 0, right: 0, bottom: 40 }, viewport)).toBeNull();
  });

  it('stops the list above a row naming a plugin, and draws none when too little room is left', () => {
    const frame = { left: 0, top: 0, right: 600, bottom: 40 };
    const anchor = { left: 0, top: 0, bottom: 30, width: 300, height: 30 };
    // A banner's name chip 100 px under the anchor, in the list's column.
    const shorter = placeFloatingDropdown(anchor, frame, frame, viewport, { avoid: [{ left: 200, top: 134, right: 320, bottom: 160 }] })!;
    expect(shorter.top! + shorter.maxHeight).toBeLessThanOrEqual(134);
    // Right under the anchor: no room.
    expect(placeFloatingDropdown(anchor, frame, frame, viewport, { avoid: [{ left: 0, top: 40, right: 600, bottom: 80 }] })).toBeNull();
    // Beside the list's column it doesn't count.
    expect(placeFloatingDropdown(anchor, frame, frame, viewport, { avoid: [{ left: 400, top: 40, right: 600, bottom: 80 }] })!.maxHeight).toBe(DROPDOWN_MAX_HEIGHT);
  });

  it('keeps the list of a frame in a plugin dialog below the frame\'s top', () => {
    // The frame from y 600 to 880, an anchor at its bottom: no room below, and above only within the frame.
    const frame = { left: 0, top: 600, right: 500, bottom: 880 };
    const anchor = { left: 0, top: 250, bottom: 270, width: 200, height: 20 };
    const place = placeFloatingDropdown(anchor, frame, frame, viewport, { top: 600 })!;
    expect(place.top).toBeUndefined();
    expect(viewport.height - place.bottom! - place.maxHeight).toBeGreaterThanOrEqual(600);
    // An anchor at the frame's top leaves no room at all.
    expect(placeFloatingDropdown({ left: 0, top: 0, bottom: 280, width: 200, height: 280 }, frame, frame, viewport, { top: 600 })).toBeNull();
  });
});
