import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposingSettings } from '../composing-settings';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import en from '@/locales/en/common.json';

// "Reply from the address it was sent to" explained catch-all matching,
// which belongs to the row below it. The row now says what it does and
// when it helps.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('ComposingSettings wording', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
    useAuthStore.setState({ client: null });
  });

  it('describes replying from the received address without the catch-all note', () => {
    render(<ComposingSettings />);
    expect(screen.getByText('reply_from_received.description')).toBeTruthy();
    expect(screen.queryByText('auto_select_reply_identity.description')).toBeNull();
    expect(en.compose_words.reply_from_received.description).not.toMatch(/catch-all|Received Address Matching/i);
  });

  it('calls the send delay "Undo send"', () => {
    render(<ComposingSettings />);
    expect(screen.getByText('undo_send.label')).toBeTruthy();
    expect(screen.queryByText('send_delay.label')).toBeNull();
    expect(en.compose_words.undo_send.label).toBe('Undo send');
  });
});
