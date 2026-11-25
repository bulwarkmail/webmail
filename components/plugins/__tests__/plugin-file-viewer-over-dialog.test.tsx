// A file a plugin opens (api.ui.openFile, or a PDF it prints) while its own dialog is open (a
// cloud storage plugin's file picker with a preview button per file) shows over that dialog. The
// dialog stays open under it, as it was: closing the preview, with its X, Escape or a click on
// its backdrop, brings the user back to the dialog. The app's own previews stay at z-50.
//
// jsdom has no layout and can't say which element is at a point. The preview and the plugin
// dialog layers are position: fixed with a z-index in the page's root stacking context: the one
// with the higher z-index is painted on top, and of two with the same z-index the one later in
// the document. The tests read the z-index each one sets (see plugin-dialog-menu-layer.test.tsx)
// and compare those, and the document order where they are the same.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Webmail' }) }));
vi.mock('@/lib/standalone-display', () => ({ canOpenUrlInNewWindow: () => false }));
const printPdfUrl = vi.fn(async () => {});
vi.mock('@/lib/print-pdf', () => ({ printPdfUrl: (...args: unknown[]) => printPdfUrl(...(args as [])) }));

const plugins = new Map<string, InstalledPlugin>();
vi.mock('@/lib/plugin-sandbox/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plugin-sandbox/registry')>()),
  get: (id: string) => {
    const plugin = plugins.get(id);
    return plugin && {
      plugin, code: '', tier: 'untrusted',
      background: { evaluateShouldShow: async () => true },
      slotOffers: [{ name: 'plugin-dialog', hasShouldShow: false, order: 100 }],
    };
  },
}));

const destroy = vi.fn();
const createSlotInstance = vi.fn((opts: { hostContainer: HTMLElement }) => {
  opts.hostContainer.appendChild(document.createElement('iframe'));
  return { destroy, updateProps: vi.fn(), setTheme: vi.fn(), sendFloatingDropdownEvent: vi.fn(), initPromise: Promise.resolve() };
});
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({ createSlotInstance: (opts: { hostContainer: HTMLElement }) => createSlotInstance(opts) }));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

import { PluginDialogHost } from '@/components/plugins/plugin-dialog-host';
import { PluginFileViewerHost } from '@/components/plugins/plugin-file-viewer-host';
import { PreviewShell, BACKDROP_GRACE_MS } from '@/components/files/preview-shell';
import { closePluginFile, currentFileView, showPluginFile } from '@/lib/plugin-sandbox/file-viewer';
import { awaitCustomDialog, awaitPrompt, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';
import { usePluginStore } from '@/stores/plugin-store';

/** The z-index an element itself sets: inline, else the app's z-50 / z-[100000] class. */
function ownZ(el: Element): number | null {
  const inline = (el as HTMLElement).style?.zIndex;
  if (inline) return Number(inline);
  for (const c of el.classList) {
    const m = /^z-(?:\[(\d+)\]|(\d+))$/.exec(c);
    if (m) return Number(m[1] ?? m[2]);
  }
  return null;
}

/** The z-index the element is painted at in the page's root stacking context. */
function paintedZ(el: Element): number {
  let z = 0;
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    const own = ownZ(n);
    if (own !== null) z = own;
  }
  return z;
}

/** `a` is painted over `b`: a higher z-index, or the same one and later in the document. */
function paintedOver(a: Element, b: Element): boolean {
  const za = paintedZ(a);
  const zb = paintedZ(b);
  if (za !== zb) return za > zb;
  return Boolean(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
}

const picker = { pluginId: 'cloud', title: 'Pick a file', message: '', slot: 'plugin-dialog' as const };
const anchor = { left: 100, top: 50, right: 124, bottom: 74 };

/** The two hosts in the layout's order. */
function renderHosts() {
  render(
    <>
      <PluginDialogHost />
      <PluginFileViewerHost />
    </>,
  );
}

async function openDialog(extra: { anchor?: typeof anchor } = {}) {
  let settled = false;
  let result: unknown;
  act(() => {
    void awaitCustomDialog({ ...picker, ...extra }).then((r) => { settled = true; result = r; });
  });
  await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
  const layer = document.querySelector('[data-plugin-dialog-layer]')!;
  return { layer, settled: () => settled, result: () => result };
}

async function openFile(opts: { print?: boolean; type?: string } = {}) {
  const type = opts.type ?? 'image/png';
  act(() => {
    showPluginFile({ pluginId: 'cloud', name: type === 'application/pdf' ? 'report.pdf' : 'photo.png', blob: new Blob(['x'], { type }), print: opts.print ?? false });
  });
  // The preview is loaded with the first file a plugin opens.
  const source = await screen.findByText('opened_by_plugin Cloud', undefined, { timeout: 5000 });
  return source.closest('[role="dialog"]')!;
}

beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
  createSlotInstance.mockClear();
  destroy.mockClear();
  printPdfUrl.mockClear();
  plugins.clear();
  const p: InstalledPlugin = {
    id: 'cloud', name: 'Cloud', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: [], grantedPermissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
  };
  plugins.set(p.id, p);
  usePluginStore.setState({ plugins: [p], disablePlugin: vi.fn() } as never);
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  const view = currentFileView();
  if (view) act(() => closePluginFile(view.id));
  while (head()) act(() => resolveHead(null));
  cleanup();
  vi.restoreAllMocks();
});

describe('a file a plugin opens from its own dialog', () => {
  it('shows over the centred dialog and its backdrop', async () => {
    renderHosts();
    const { layer } = await openDialog();
    const preview = await openFile();

    expect(paintedOver(preview, layer)).toBe(true);
    expect(paintedOver(preview, layer.querySelector('iframe')!)).toBe(true);
  });

  it('shows over a dialog beside the control the user clicked', async () => {
    renderHosts();
    const { layer } = await openDialog({ anchor });
    expect(layer).toHaveAttribute('data-plugin-dialog-popover');
    const preview = await openFile();

    expect(paintedOver(preview, layer)).toBe(true);
  });

  it('shows a PDF the plugin prints over the dialog', async () => {
    renderHosts();
    const { layer } = await openDialog();
    const preview = await openFile({ print: true, type: 'application/pdf' });

    expect(paintedOver(preview, layer)).toBe(true);
  });

  it('stays under what has to stay on top: a confirm the plugin opens over it, the lock screen', async () => {
    renderHosts();
    await openDialog();
    const preview = await openFile();
    act(() => { void awaitPrompt({ pluginId: 'cloud', kind: 'confirm', title: 'Delete photo.png?', message: '' }); });
    await waitFor(() => expect(document.querySelectorAll('[data-plugin-dialog-layer]')).toHaveLength(2));
    const confirm = document.querySelectorAll('[data-plugin-dialog-layer]')[1];

    expect(paintedOver(confirm, preview)).toBe(true);
    // The lock screen, the session timeout dialog and the consent dialogs are at z-[100001].
    expect(paintedZ(preview)).toBeLessThan(100001);
  });

  it('closes alone on Escape; the next Escape closes the dialog', async () => {
    renderHosts();
    const dialog = await openDialog();
    const preview = await openFile();

    fireEvent.keyDown(preview, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('opened_by_plugin Cloud')).toBeNull());
    expect(currentFileView()).toBeNull();
    await Promise.resolve();
    expect(dialog.settled()).toBe(false);
    expect(dialog.layer.isConnected).toBe(true);
    // The dialog's frame was kept, not loaded again.
    expect(createSlotInstance).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    // The focus is back in the dialog.
    expect(dialog.layer.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(dialog.settled()).toBe(true));
    expect(dialog.result()).toBeNull();
  });

  it('closes alone on a click on its backdrop', async () => {
    renderHosts();
    const dialog = await openDialog();
    const preview = await openFile();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + BACKDROP_GRACE_MS + 1);

    fireEvent.mouseDown(preview);
    fireEvent.mouseUp(preview);
    fireEvent.click(preview);
    await waitFor(() => expect(currentFileView()).toBeNull());
    await Promise.resolve();
    expect(dialog.settled()).toBe(false);
    expect(dialog.layer.isConnected).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('closes alone with its X', async () => {
    renderHosts();
    const dialog = await openDialog();
    await openFile();

    fireEvent.click(screen.getByRole('button', { name: 'close_preview' }));
    await waitFor(() => expect(currentFileView()).toBeNull());
    await Promise.resolve();
    expect(dialog.settled()).toBe(false);
    expect(dialog.layer.isConnected).toBe(true);
  });
});

describe('the app\'s own previews', () => {
  it('stay at z-50', () => {
    render(<PreviewShell name="invoice.pdf" onClose={vi.fn()}><div /></PreviewShell>);
    expect(ownZ(screen.getByRole('dialog'))).toBe(50);
  });
});
