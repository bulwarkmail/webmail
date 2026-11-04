import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOfflineStore } from '@/lib/offline/state';
import { KeyProtectionNotes } from '../key-protection-notes';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
}));

function withShell(wrap: boolean): void {
  (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
    version: 1,
    platform: 'linux',
    appLock: { status: async () => ({ wrap }) },
  };
}

describe('what settings say about the key', () => {
  beforeEach(() => useOfflineStore.setState({ keyUnprotected: false, rekey: {} }));
  afterEach(() => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  });

  it('a browser says it has no layer of the OS', async () => {
    await act(async () => { render(<KeyProtectionNotes browser />); });
    expect(screen.getByText('browser_note')).toBeTruthy();
  });

  it('the desktop app with a real key store says nothing', async () => {
    withShell(true);
    await act(async () => { render(<KeyProtectionNotes browser />); });
    expect(screen.queryByTestId('key-protection-notes')).toBeNull();
  });

  it('Linux with no secret service says secrets are only obfuscated', async () => {
    withShell(false);
    await act(async () => { render(<KeyProtectionNotes browser />); });
    expect(screen.getByText('no_secure_storage')).toBeTruthy();
    expect(screen.queryByText('browser_note')).toBeNull();
  });

  it('says out loud when the key store refused, and how a re-encryption goes', async () => {
    withShell(true);
    useOfflineStore.setState({ keyUnprotected: true, rekey: { a: 40, b: 'failed' } });
    await act(async () => { render(<KeyProtectionNotes />); });
    expect(screen.getByText('wrap_failed')).toBeTruthy();
    expect(screen.getByText('rekey_failed')).toBeTruthy();
    expect(screen.getByText('rekey_progress:{"percent":40}')).toBeTruthy();
  });
});
