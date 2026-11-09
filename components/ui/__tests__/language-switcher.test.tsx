import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/detect-locale', () => ({ getEffectiveLocale: () => 'de' }));

import { useLocaleStore } from '@/stores/locale-store';
import { LanguageSwitcher } from '../language-switcher';

const setLocale = vi.fn();

function openMenu() {
  render(<LanguageSwitcher />);
  fireEvent.click(screen.getByRole('button', { name: /English/ }));
  return screen.getByRole('combobox');
}

const optionNames = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn(); // not in jsdom
    setLocale.mockClear();
    useLocaleStore.setState({ locale: 'en', setLocale });
  });

  it('focuses the search box and starts on the current language', () => {
    const input = openMenu();
    expect(document.activeElement).toBe(input);
    const active = input.getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).toContain('English');
  });

  it('finds a language by its native, UI-language or English name, ignoring accents', () => {
    const input = openMenu();
    fireEvent.change(input, { target: { value: 'espanol' } });
    expect(optionNames()).toEqual([expect.stringContaining('Español')]);

    // UI language is German: "Französisch" is the display name for fr.
    fireEvent.change(input, { target: { value: 'französisch' } });
    expect(optionNames()).toEqual([expect.stringContaining('Français')]);

    fireEvent.change(input, { target: { value: 'hungarian' } });
    expect(optionNames()).toEqual([expect.stringContaining('Magyar')]);
  });

  it('picks the highlighted result with the keyboard', () => {
    const input = openMenu();
    fireEvent.change(input, { target: { value: 'pol' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(setLocale).toHaveBeenCalledWith('pl');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('moves through results with the arrow keys', () => {
    const input = openMenu();
    fireEvent.change(input, { target: { value: 'sk' } });
    expect(optionNames().slice(0, 2)).toEqual([expect.stringContaining('Česky'), expect.stringContaining('Dansk')]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(setLocale).toHaveBeenCalledWith('da');
  });

  it('lists languages by their own names, Auto first and Latin scripts before others', () => {
    openMenu();
    const names = screen.getAllByRole('option').map((o) => o.querySelector('[dir="auto"]')?.textContent);
    expect(names.slice(0, 6)).toEqual(['Auto', 'Català', 'Česky', 'Dansk', 'Deutsch', 'Eesti']);
    // Slovenčina sorts with S, between Română and Tiếng Việt.
    const sk = names.indexOf('Slovenčina');
    expect(names[sk - 1]).toBe('Română');
    expect(names[sk + 1]).toBe('Tiếng Việt');
    // Every Latin-script name comes before the first non-Latin one.
    const firstOther = names.findIndex((n) => !/^[\p{Script=Latin}\s]+$/u.test(n ?? ''));
    expect(names.slice(firstOther).every((n) => !/^\p{Script=Latin}/u.test(n ?? ''))).toBe(true);
  });

  it('says so when nothing matches', () => {
    const input = openMenu();
    fireEvent.change(input, { target: { value: 'klingon' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('sharing.no_match')).toBeTruthy();
  });
});
