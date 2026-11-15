import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings-store';
import { AboutDataSettings, TroubleshootingSettings } from '../about-data-settings';

// Backup & reset: Reset asks in a ConfirmDialog (no button that turns into
// a red "Yes"), and every result is a toast, never a browser alert().

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../debug-settings', () => ({ DebugSettings: () => null }));

const initial = useSettingsStore.getState();
let alertSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
});
afterEach(() => {
  useSettingsStore.setState(initial, true);
  alertSpy.mockRestore();
});

describe('Backup & reset', () => {
  // Reset moved to Troubleshooting in the settings reorg (2026-11-05).
  it('resets only after the dialog is confirmed, then says so in a toast', () => {
    const resetToDefaults = vi.fn();
    useSettingsStore.setState({ resetToDefaults });
    render(<TroubleshootingSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'reset_settings.button' }));
    expect(resetToDefaults).not.toHaveBeenCalled();
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText('reset_settings.confirm_title')).toBeTruthy();

    fireEvent.click(dialog.getByRole('button', { name: 'reset_settings.button' }));
    expect(resetToDefaults).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('reset_settings.done');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('reports an import that fails in an error toast', async () => {
    useSettingsStore.setState({ importSettings: vi.fn(() => false) });
    const { container } = render(<AboutDataSettings />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['not json'], 'settings.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('import_error'));
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

// SET-25: the About card in the settings sidebar is named by what it shows,
// not a hard-coded English "About". Its focus is the global outline from
// app/accessibility.css, so it carries no box-shadow ring of its own that
// would draw a second ring (and vanish in forced colours).
describe('About card', () => {
  it('leaves the focus to the global outline and has no hard-coded English name', async () => {
    const { AboutFooter } = await import('../about-data-settings');
    render(<AboutFooter />);
    const button = screen.getByTestId('settings-about').querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBeNull();
    expect(button.className).not.toMatch(/focus(-visible)?:ring/);
    expect(button.className).not.toContain('outline-none');
    expect(button.textContent).toContain('about.title');
  });
});
