import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useSettingsStore } from '@/stores/settings-store';
import { LanguageSettings } from '../language-settings';

// settings-18: the time zone is a searchable list by city and offset, the
// common zones first, with today's city names; the stored value stays the
// IANA id the runtime knows.

vi.mock('@/i18n/detect-locale', () => ({ getEffectiveLocale: () => 'en', detectBrowserLocale: () => 'en' }));

function openTimeZones() {
  render(<LanguageSettings />);
  fireEvent.click(screen.getByRole('button', { name: /^time_zone\.label/ }));
  return screen.getByRole('combobox', { name: 'time_zone_search' });
}

// Only the time zone list's options: the page's other selects have options too.
const optionTexts = () => {
  const list = document.getElementById(screen.getByRole('combobox', { name: 'time_zone_search' }).getAttribute('aria-controls')!)!;
  return within(list).queryAllByRole('option').map((o) => o.textContent ?? '');
};

describe('time zone setting', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useSettingsStore.setState({ timeZone: 'auto' });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('is not a plain native select of zone ids', () => {
    render(<LanguageSettings />);
    expect(screen.queryAllByRole('option').some((o) => (o.textContent ?? '').includes('Asia/'))).toBe(false);
  });

  it('lists the common zones first, by city and offset', () => {
    openTimeZones();
    const texts = optionTexts();
    // "Automatic" first, then the common group.
    expect(texts[1]).toMatch(/^UTC/);
    expect(texts.slice(1, 16).some((text) => /^Berlin\s*GMT\+0[12]:00/.test(text))).toBe(true);
    expect(screen.getByText('time_zone_common')).toBeTruthy();
    expect(screen.getByText('time_zone_all')).toBeTruthy();
  });

  it('finds a city by its current name and stores the id the runtime knows', () => {
    const update = vi.spyOn(useSettingsStore.getState(), 'updateSetting');
    const input = openTimeZones();
    fireEvent.change(input, { target: { value: 'kolkata' } });
    const texts = optionTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^Kolkata\s*GMT\+05:30/);
    fireEvent.keyDown(input, { key: 'Enter' });
    const runtimeIds = Intl.supportedValuesOf('timeZone');
    const stored = update.mock.calls.at(-1)?.[1] as string;
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(stored);
    expect(runtimeIds).toContain(stored);
  });

  it('shows Kyiv and Ho Chi Minh City, never the old names', () => {
    const input = openTimeZones();
    fireEvent.change(input, { target: { value: 'kiev' } });
    expect(optionTexts()[0]).toMatch(/^Kyiv/);
    fireEvent.change(input, { target: { value: 'saigon' } });
    expect(optionTexts()[0]).toMatch(/^Ho Chi Minh City/);
  });

  it('finds zones by offset', () => {
    const input = openTimeZones();
    fireEvent.change(input, { target: { value: '+05:45' } });
    expect(optionTexts()).toEqual([expect.stringMatching(/^Kathmandu/)]);
  });

  // settings-p2-20: abbreviations and an exact offset find their zones first.
  it('finds zones by abbreviation', () => {
    const input = openTimeZones();
    fireEvent.change(input, { target: { value: 'CET' } });
    const found = optionTexts();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(expect.arrayContaining([expect.stringMatching(/^Berlin/), expect.stringMatching(/^Paris/)]));
    fireEvent.change(input, { target: { value: 'pst' } });
    expect(optionTexts()[0]).toMatch(/^Los Angeles/);
  });

  it('lists the exact offset before offsets that start with the same digits', () => {
    const input = openTimeZones();
    fireEvent.change(input, { target: { value: 'GMT+1' } });
    const found = optionTexts();
    const offsetOf = (text: string) => /GMT[+-]\d{2}:\d{2}/.exec(text)?.[0];
    const first = offsetOf(found[0]);
    // Whatever +1 is today (winter or summer time), it's listed first.
    expect(first).toMatch(/^GMT\+01:00$/);
    const firstOther = found.findIndex((text) => offsetOf(text) !== first);
    expect(found.slice(firstOther).every((text) => offsetOf(text) !== 'GMT+01:00')).toBe(true);
  });
});
