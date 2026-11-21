import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathname = vi.hoisted(() => ({ value: '/mail' }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ push }),
}));

import { AccessibilityQuickPanelHost, isAccessibilityPanelShortcut, openAccessibilityPanel } from '../accessibility-quick-panel';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { forgetSignedOutChoices, signedOutChoices } from '@/lib/signed-out-choices';

const pressAltShiftA = () =>
  fireEvent.keyDown(window, { key: 'A', code: 'KeyA', altKey: true, shiftKey: true });

beforeEach(() => {
  pathname.value = '/mail';
  push.mockReset();
  forgetSignedOutChoices();
  useSettingsStore.getState().resetToDefaults();
  useAuthStore.setState({ isAuthenticated: true } as never);
});

// The panel's code comes with its first open, so it shows a moment after the key.
describe('accessibility quick panel', () => {
  it('opens with Alt+Shift+A, also with single-key shortcuts off', async () => {
    useSettingsStore.getState().updateSetting('singleKeyShortcuts', false);
    render(<AccessibilityQuickPanelHost />);
    expect(screen.queryByTestId('accessibility-panel')).toBeNull();
    pressAltShiftA();
    expect(await screen.findByTestId('accessibility-panel')).toBeTruthy();
  });

  // With the focus outline off this is the way back, so it keeps the outline here.
  it('keeps the focus outline on its controls', async () => {
    render(<AccessibilityQuickPanelHost />);
    pressAltShiftA();
    const panel = await screen.findByTestId('accessibility-panel');
    const kept = screen.getByRole('button', { name: 'settings.accessibility.focus_ring.off' }).closest('[data-keep-focus-outline]');
    expect(kept).not.toBeNull();
    expect(panel.contains(kept)).toBe(true);
  });

  it('matches the physical key, not the character a layout produces', () => {
    expect(isAccessibilityPanelShortcut(new KeyboardEvent('keydown', { key: 'Å', code: 'KeyA', altKey: true, shiftKey: true }))).toBe(true);
    expect(isAccessibilityPanelShortcut(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', altKey: true }))).toBe(false);
    expect(isAccessibilityPanelShortcut(new KeyboardEvent('keydown', { key: 'A', code: 'KeyA', altKey: true, shiftKey: true, ctrlKey: true }))).toBe(false);
  });

  it('changes text size from the panel', async () => {
    render(<AccessibilityQuickPanelHost />);
    act(() => openAccessibilityPanel());
    const select = (await screen.findByTestId('accessibility-panel')).querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'x-large' } });
    expect(useSettingsStore.getState().fontSize).toBe('x-large');
  });

  it('shows a button on the sign-in page with the options that change how a page reads and works', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    pathname.value = '/login';
    render(<AccessibilityQuickPanelHost />);
    fireEvent.click(screen.getByTestId('login-accessibility-button'));
    const panel = await screen.findByTestId('accessibility-panel');
    for (const option of ['text_size', 'font', 'contrast', 'underline_links', 'focus_ring', 'large_targets', 'reduce_motion']) {
      expect(panel.textContent).toContain(`settings.accessibility.${option}.label`);
    }
    // The mail ones and the presets, which are mostly about mail, wait for the app.
    expect(panel.textContent).not.toContain('settings.accessibility.single_key_shortcuts.label');
    expect(panel.textContent).not.toContain('settings.accessibility.presets.title');
    expect(panel.textContent).not.toContain('accessibility_panel.all_settings');
  });

  it('remembers what was changed on the sign-in page for after the sign-in', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    pathname.value = '/login';
    render(<AccessibilityQuickPanelHost />);
    fireEvent.click(screen.getByTestId('login-accessibility-button'));
    const panel = await screen.findByTestId('accessibility-panel');
    fireEvent.change(panel.querySelector('select') as HTMLSelectElement, { target: { value: 'xx-large' } });
    expect(useSettingsStore.getState().fontSize).toBe('xx-large');
    expect(signedOutChoices()).toEqual(['fontSize']);
  });

  it('notes nothing when the change is made in the app', async () => {
    render(<AccessibilityQuickPanelHost />);
    act(() => openAccessibilityPanel());
    const select = (await screen.findByTestId('accessibility-panel')).querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'large' } });
    expect(signedOutChoices()).toEqual([]);
  });

  it('has no sign-in button inside the app', () => {
    render(<AccessibilityQuickPanelHost />);
    expect(screen.queryByTestId('login-accessibility-button')).toBeNull();
  });

  it('goes to the settings page through the app router', async () => {
    render(<AccessibilityQuickPanelHost />);
    act(() => openAccessibilityPanel());
    fireEvent.click(await screen.findByRole('button', { name: 'accessibility_panel.all_settings' }));
    expect(push).toHaveBeenCalledWith('/settings/accessibility');
  });
});
