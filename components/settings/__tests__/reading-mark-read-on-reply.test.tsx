import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingSettings } from '../reading-settings';
import { useSettingsStore } from '@/stores/settings-store';

// #1756: Settings > Reading has "Mark as read after replying or forwarding", on
// by default and apart from "Mark as read".

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div data-testid="section">{children}</div>,
}));
vi.mock('../downloads-settings', () => ({ DownloadsSettings: () => null }));

describe('Reading > Mark as read after replying or forwarding (#1756)', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('is on by default and turns off without touching "Mark as read"', () => {
    useSettingsStore.setState({ markAsReadDelay: -1 });
    render(<ReadingSettings />);
    const toggle = screen.getByTestId('settings-mark-read-on-reply');
    expect(screen.getByText('mark_read_on_reply.label')).toBeInTheDocument();
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);

    expect(useSettingsStore.getState().markReadOnReply).toBe(false);
    expect(useSettingsStore.getState().markAsReadDelay).toBe(-1);
  });
});
