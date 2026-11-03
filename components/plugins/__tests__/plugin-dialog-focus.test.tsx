import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// A plugin's dialog is a real modal for the keyboard: the focus moves in to
// the safe choice, Tab can't leave it, and the focus comes back to where it
// was once the dialog is answered.

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('../plugin-iframe-slot', () => ({ PluginIframeSlot: () => <div data-testid="custom-frame" /> }));

import { PluginDialogHost } from '../plugin-dialog-host';
import { awaitDialog, awaitPrompt, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';

let opener: HTMLButtonElement;
beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
  opener = document.createElement('button');
  opener.textContent = 'opener';
  document.body.appendChild(opener);
  opener.focus();
});
afterEach(() => opener.remove());

describe('plugin dialog focus', () => {
  it('starts on Cancel for a destructive confirm, keeps Tab inside, and returns the focus', async () => {
    render(<PluginDialogHost />);
    let answer: Promise<boolean>;
    act(() => { answer = awaitDialog({ pluginId: 'p', kind: 'confirm', title: 'Delete it?', message: '', danger: true }); });

    const cancel = screen.getByRole('button', { name: 'cancel' });
    expect(cancel).toHaveFocus();
    const dialog = screen.getByRole('dialog', { name: 'Delete it?' });
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await act(async () => { fireEvent.click(cancel); });
    await expect(answer!).resolves.toBe(false);
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('starts in the first field of a prompt and marks required fields', async () => {
    render(<PluginDialogHost />);
    let answer: Promise<Record<string, string> | null>;
    act(() => {
      answer = awaitPrompt({ pluginId: 'p', kind: 'prompt', title: 'Name', message: '', fields: [{ name: 'n', label: 'Name', required: true }] });
    });
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-required', 'true');
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    await expect(answer!).resolves.toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('lets the keyboard reach a confirm message to scroll it, starting on the button', () => {
    render(<PluginDialogHost />);
    act(() => { void awaitDialog({ pluginId: 'p', kind: 'confirm', title: 'Send?', message: 'A long list of recipients' }); });

    expect(screen.getByRole('button', { name: 'confirm' })).toHaveFocus();
    expect(screen.getByText('A long list of recipients').parentElement).toHaveAttribute('tabindex', '0');
  });

  it('lets the keyboard reach a prompt message to scroll it, starting in the field', () => {
    render(<PluginDialogHost />);
    act(() => {
      void awaitPrompt({ pluginId: 'p', kind: 'prompt', title: 'Name', message: 'A long explanation', fields: [{ name: 'n', label: 'Name' }] });
    });

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    expect(screen.getByText('A long explanation').parentElement).toHaveAttribute('tabindex', '0');
  });

  it('adds no stop for Tab when there is no message', () => {
    render(<PluginDialogHost />);
    act(() => { void awaitDialog({ pluginId: 'p', kind: 'confirm', title: 'Send?', message: '' }); });

    expect(screen.getByRole('dialog').querySelector('[tabindex="0"]')).toBeNull();
  });
});
