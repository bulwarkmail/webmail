import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings-store';

// #1814: Settings > Reading has "Double-click a message" where a message can
// open in a window of its own; the desktop app keeps its own switch.

const popouts = vi.hoisted(() => ({ available: true, desktop: false }));
vi.mock('@/hooks/use-popouts-available', () => ({ usePopoutsAvailable: () => popouts.available }));
vi.mock('@/lib/popout/support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/popout/support')>()),
  hasDesktopWindows: () => popouts.desktop,
}));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div data-testid="section">{children}</div>,
}));
vi.mock('../downloads-settings', () => ({ DownloadsSettings: () => null }));

const { ReadingSettings } = await import('../reading-settings');

const row = () => screen.queryByText('message_double_click.label');

describe('Reading > Double-click a message (#1814)', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
    popouts.available = true;
    popouts.desktop = false;
  });
  afterEach(cleanup);

  it('opens in the reading pane by default, and can open a new window', () => {
    render(<ReadingSettings />);
    expect(row()).toBeInTheDocument();
    const select = screen.getByDisplayValue('message_double_click.reading_pane') as HTMLSelectElement;
    expect(useSettingsStore.getState().messageDoubleClick).toBe('reading-pane');

    fireEvent.change(select, { target: { value: 'new-window' } });

    expect(useSettingsStore.getState().messageDoubleClick).toBe('new-window');
  });

  it('is not offered where messages cannot open in a window of their own', () => {
    popouts.available = false;
    render(<ReadingSettings />);
    expect(row()).toBeNull();
  });

  it('is not offered in the desktop app, which has its own switch', () => {
    popouts.desktop = true;
    render(<ReadingSettings />);
    expect(row()).toBeNull();
  });
});
