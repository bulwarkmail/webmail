import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

// Escape in a plugin dialog closes that dialog and nothing else. An event
// popover or the event form behind it listens for Escape on the window.

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('../plugin-iframe-slot', () => ({ PluginIframeSlot: () => <div data-testid="custom-frame" /> }));

import { PluginDialogHost } from '../plugin-dialog-host';
import { awaitCustomDialog, awaitPrompt, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';

const behind = vi.fn();
const onWindowKey = (e: KeyboardEvent) => { if (e.key === 'Escape') behind(); };

beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
  behind.mockClear();
  window.addEventListener('keydown', onWindowKey);
});
afterEach(() => window.removeEventListener('keydown', onWindowKey));

describe('Escape in a plugin dialog', () => {
  it('closes a custom dialog without reaching what is behind it', async () => {
    render(<PluginDialogHost />);
    let answer: Promise<unknown>;
    act(() => { answer = awaitCustomDialog({ pluginId: 'p', title: 'Pick', message: '', slot: 'plugin-dialog' }); });

    // What the bridge does for a frame-escape: the key event starts at the frame.
    await act(async () => { fireEvent.keyDown(screen.getByTestId('custom-frame'), { key: 'Escape' }); });

    await expect(answer!).resolves.toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(behind).not.toHaveBeenCalled();
  });

  it('closes a prompt without reaching what is behind it', async () => {
    render(<PluginDialogHost />);
    let answer: Promise<unknown>;
    act(() => { answer = awaitPrompt({ pluginId: 'p', kind: 'prompt', title: 'Name', message: '', fields: [{ name: 'n', label: 'Name' }] }); });

    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Escape' }); });

    await expect(answer!).resolves.toBeNull();
    expect(behind).not.toHaveBeenCalled();
  });

  it('leaves Escape to the rest of the app once the dialog is gone', async () => {
    render(<PluginDialogHost />);
    act(() => { void awaitCustomDialog({ pluginId: 'p', title: 'Pick', message: '', slot: 'plugin-dialog' }); });
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(behind).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(behind).toHaveBeenCalledTimes(1);
  });
});
