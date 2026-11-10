import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessibilitySettings } from '../accessibility-settings';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { ACCESSIBILITY_PRESET_IDS, presetChanges } from '@/lib/accessibility-presets';

// Labels are their keys; plural/ICU arguments are appended so tests can see them.
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ''}${key}${values ? ` ${JSON.stringify(values)}` : ''}`,
  useLocale: () => 'de',
}));

const settings = () => useSettingsStore.getState();

beforeEach(() => {
  localStorage.clear();
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, loaded: true });
  settings().resetToDefaults();
});

function presetButton(name: string) {
  return screen.getByRole('button', { name: new RegExp(`settings\\.accessibility\\.presets\\.${name}\\.label`) });
}

describe('accessibility presets', () => {
  it('changes several settings at once and lists what changed', () => {
    render(<AccessibilitySettings />);
    fireEvent.click(presetButton('low-vision'));
    expect(settings().fontSize).toBe('xx-large');
    expect(settings().contrast).toBe('more');
    expect(settings().largeCursor).toBe(true);
    const summary = screen.getByTestId('preset-summary');
    expect(within(summary).getByText('settings.accessibility.text_size.label')).toBeTruthy();
    expect(within(summary).getByText('settings.accessibility.contrast.label')).toBeTruthy();
  });

  it('undoes exactly what the preset changed', () => {
    settings().updateSetting('fontSize', 'large');
    settings().updateSetting('underlineLinks', true);
    render(<AccessibilitySettings />);
    fireEvent.click(presetButton('low-vision'));
    expect(settings().fontSize).toBe('xx-large');
    fireEvent.click(screen.getByRole('button', { name: 'settings.accessibility.presets.undo' }));
    expect(settings().fontSize).toBe('large');
    // Already on before the preset; the undo must not switch it off.
    expect(settings().underlineLinks).toBe(true);
    expect(settings().contrast).toBe('system');
  });

  it('draws each preset on its card without adding to the name screen readers hear', () => {
    render(<AccessibilitySettings />);
    for (const id of ACCESSIBILITY_PRESET_IDS) {
      // jsdom joins the two spans without a space, so compare without any.
      const expected = `settings.accessibility.presets.${id}.labelsettings.accessibility.presets.${id}.description`;
      const button = screen.getByRole('button', { name: (name) => name.replace(/\s/g, '') === expected });
      const preview = within(button).getByTestId(`preset-preview-${id}`);
      expect(preview.getAttribute('aria-hidden')).toBe('true');
      expect(preview.querySelector('span, svg')).toBeTruthy();
    }
  });

  it('combines presets: a second one keeps what the first set', () => {
    render(<AccessibilitySettings />);
    fireEvent.click(presetButton('dyslexia'));
    fireEvent.click(presetButton('motion'));
    expect(settings().appFont).toBe('atkinson');
    expect(settings().reduceMotion).toBe('on');
  });

  it('offers to show the quick button after a preset', () => {
    render(<AccessibilitySettings />);
    fireEvent.click(presetButton('motor'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.accessibility.presets.show_button' }));
    expect(settings().showAccessibilityButton).toBe(true);
  });

  it('skips settings the admin locked and toast durations under the minimum', () => {
    const state = { ...settings() } as unknown as Record<string, unknown>;
    const changes = presetChanges('hearing', state, (key) => key === 'emailNotificationSound');
    expect(changes.map((c) => c.key)).not.toContain('emailNotificationSound');

    const motor = presetChanges('motor', state, () => false, (key, value) => key !== 'toastDuration' || (value as number) >= 60);
    expect(motor.map((c) => c.key)).not.toContain('toastDuration');
  });
});

describe('reset', () => {
  it('puts the accessibility settings back to their defaults', () => {
    settings().updateSetting('appFont', 'lexend');
    settings().updateSetting('fontSize', 'huge');
    settings().updateSetting('disableThreading', true);
    render(<AccessibilitySettings />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.accessibility.reset.button' }));
    expect(settings().appFont).toBe('default');
    expect(settings().fontSize).toBe('medium');
    // A shared everyday preference is not an accessibility setting to reset.
    expect(settings().disableThreading).toBe(true);
  });

  it("gives back the organisation's defaults instead of writing Bulwark's as the user's choice", () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, defaults: { appFont: 'atkinson', fontSize: 'large' } }, loaded: true });
    settings().applyAdminPolicy();
    settings().updateSetting('appFont', 'lexend');
    settings().updateSetting('fontSize', 'huge');
    render(<AccessibilitySettings />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.accessibility.reset.button' }));
    expect(settings().appFont).toBe('atkinson');
    expect(settings().fontSize).toBe('large');
    // Nothing is left marked as chosen, so a later change of the default reaches the user.
    expect(settings().explicitSettings).not.toContain('appFont');
    expect(settings().explicitSettings).not.toContain('fontSize');
  });

  it('also resets the plain text font and the send confirmation', () => {
    settings().updateSetting('plainTextFont', 'mono');
    settings().updateSetting('sendConfirmation', true);
    render(<AccessibilitySettings />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.accessibility.reset.button' }));
    expect(settings().plainTextFont).toBe('sans');
    expect(settings().sendConfirmation).toBe(false);
  });
});

// With the focus outline off there is no outline to show after clicks either.
describe('focus outline off', () => {
  it('disables Always show focus until an outline is chosen', () => {
    render(<AccessibilitySettings />);
    const always = () => screen.getByRole('switch', { name: 'settings.accessibility.focus_always.label' });
    // Off is the default.
    expect(settings().focusRing).toBe('off');
    expect(always()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.accessibility.focus_ring.normal' }));
    expect(settings().focusRing).toBe('normal');
    expect(always()).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.accessibility.focus_ring.off' }));
    expect(settings().focusRing).toBe('off');
    expect(always()).toBeDisabled();
  });
});

describe('toast duration', () => {
  it('only offers durations at or above the admin minimum', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, restrictions: { toastDuration: { min: 20 } } }, loaded: true });
    render(<AccessibilitySettings />);
    const select = screen.getAllByRole('combobox').find((el) =>
      Array.from((el as HTMLSelectElement).options).some((o) => o.textContent?.includes('until_closed')),
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['20', '60', '0']);
  });
});

// settings-p3-20 (2026-11-04): sizes in four styles ("87.5%", "88 %", "12 px", "14px").
// Percentages in the language's own style (German here: "87,5 %"), pixels as "{size} px".
describe('sizes', () => {
  const optionsOf = (label: string) =>
    Array.from((screen.getByRole('combobox', { name: label }) as HTMLSelectElement).options).map((o) => o.textContent ?? '');

  it('writes message text sizes as the language writes percentages', () => {
    render(<AccessibilitySettings />);
    const options = optionsOf('settings.accessibility.mail_text_size.label');
    expect(options.slice(1, 4).map((o) => o.replace(/\s/g, ' '))).toEqual(['87,5 %', '100 %', '112,5 %']);
  });

  it('writes the sizes for new messages like the smallest-text sizes, "{size} px"', () => {
    render(<AccessibilitySettings />);
    const options = optionsOf('settings.accessibility.compose_size.label');
    expect(options.slice(1, 3)).toEqual(['settings.accessibility.mail_min_font_size.px {"size":14}', 'settings.accessibility.mail_min_font_size.px {"size":16}']);
    expect(options.some((o) => /\dpx/.test(o))).toBe(false);
  });
});

describe('read aloud voice', () => {
  const voice = (name: string, lang: string) => ({ name, lang, voiceURI: `uri:${name}`, default: false, localService: true });

  it('offers the browser default and the voices for the interface language', () => {
    const voices = [voice('Anna', 'de-DE'), voice('Daniel', 'en-GB'), voice('Markus', 'de-AT')];
    vi.stubGlobal('SpeechSynthesisUtterance', class {});
    vi.stubGlobal('speechSynthesis', { getVoices: () => voices, addEventListener() {}, removeEventListener() {} });
    try {
      render(<AccessibilitySettings />);
      const select = screen.getByRole('combobox', { name: 'settings.accessibility.read_aloud_voice.label' }) as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['settings.accessibility.read_aloud_voice.default', 'Anna', 'Markus']);
      fireEvent.change(select, { target: { value: 'uri:Markus' } });
      expect(settings().readAloudVoice).toBe('uri:Markus');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// settings-10 (2026-11-04): Accessibility repeated about twenty settings of
// other pages, two rows of it called "Notification sound". Only access
// settings stay; a link row in each section leads to the page with the rest.
describe('one setting, one place', () => {
  const borrowed = [
    'settings.appearance.list_density.label',
    'settings.appearance.toolbar_labels.label',
    'settings.email_behavior.always_light_mode.label',
    'calendar.settings.hover_preview',
    'settings.email_behavior.group_conversations.label',
    'settings.email_behavior.show_preview.label',
    'settings.advanced.sender_favicons.label',
    'settings.email_behavior.mark_read.label',
    'settings.email_behavior.return_to_list_after_action.label',
    'settings.email_behavior.send_delay.label',
    'settings.email_behavior.confirm_bulk_delete.label',
    'settings.notifications.email.sound',
    'settings.notifications.calendar.sound',
    'settings.notifications.sound_selection.choose',
    'settings.appearance.favicon_unread_badge.label',
  ];

  it('draws no row that belongs to another page', () => {
    const { container } = render(<AccessibilitySettings />);
    const rows = Array.from(container.querySelectorAll('[data-search-label]')).map((el) => el.getAttribute('data-search-label'));
    expect(rows.filter((row) => borrowed.includes(row ?? ''))).toEqual([]);
  });

  it('links to the pages that have them', () => {
    const goTo: unknown[] = [];
    const listener = (e: Event) => goTo.push((e as CustomEvent).detail);
    window.addEventListener('settings-tab-change', listener);
    try {
      render(<AccessibilitySettings />);
      for (const link of ['text', 'light_mode', 'list', 'reading', 'bulk_delete', 'sounds']) {
        expect(screen.getByText(`uxs_structure.a11y_links.${link}.label`)).toBeTruthy();
      }
      const soundsRow = screen.getByText('uxs_structure.a11y_links.sounds.label').closest('[data-search-label]') as HTMLElement;
      fireEvent.click(within(soundsRow).getByRole('button'));
      expect(goTo).toEqual([{ tab: 'notifications', section: 'sound' }]);
    } finally {
      window.removeEventListener('settings-tab-change', listener);
    }
  });
});
