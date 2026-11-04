import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { InstalledPlugin } from '@/lib/plugin-types';

// Keys in a frame never reach the page, so a dialog with the focus in one of
// its fields hears of Escape through a message from the frame. The real slot
// and bridge here: only the frame's document is missing.

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/plugin-sandbox/host-api', () => ({ dispatchApiCall: vi.fn(async () => 'ok') }));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({ dark: false }) }));

const plugin: InstalledPlugin = {
  id: 'p', name: 'P', version: '1.0.0', author: '', description: '', type: 'ui-extension',
  permissions: [], grantedPermissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
};
vi.mock('@/lib/plugin-sandbox/registry', () => ({
  get: () => ({
    plugin, code: '', tier: 'untrusted', background: {},
    slotOffers: [{ name: 'plugin-dialog', hasShouldShow: false, order: 100 }],
  }),
}));

import { PluginDialogHost } from '../plugin-dialog-host';
import { awaitCustomDialog, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';

const behind = vi.fn();
const onWindowKey = (e: KeyboardEvent) => { if (e.key === 'Escape') behind(); };

beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
  behind.mockClear();
  window.addEventListener('keydown', onWindowKey);
});
afterEach(() => window.removeEventListener('keydown', onWindowKey));

async function openDialog() {
  render(<PluginDialogHost />);
  let answer!: Promise<unknown>;
  act(() => { answer = awaitCustomDialog({ pluginId: 'p', title: 'Pick', message: '', slot: 'plugin-dialog' }); });
  const dialog = screen.getByRole('dialog', { name: 'Pick' });
  await waitFor(() => expect(dialog.querySelector('iframe')).not.toBeNull());
  return { answer, iframe: dialog.querySelector('iframe') as HTMLIFrameElement };
}

const fromFrame = (iframe: HTMLIFrameElement, data: unknown, origin = 'null') => act(async () => {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: iframe.contentWindow }));
});

describe('a frame-escape message from a plugin dialog', () => {
  it('closes the dialog and answers it as cancelled', async () => {
    const { answer, iframe } = await openDialog();
    await fromFrame(iframe, { type: 'frame-escape' });

    await expect(answer).resolves.toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(behind).not.toHaveBeenCalled();
  });

  it('counts only when it comes from the dialog frame itself', async () => {
    const { iframe } = await openDialog();
    await fromFrame(iframe, { type: 'frame-escape' }, 'https://attacker.example');
    expect(screen.getByRole('dialog', { name: 'Pick' })).toBeInTheDocument();
  });
});
