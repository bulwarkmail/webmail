import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { SettingsSkeleton, SettingsSkeletonBody } from '../settings-skeleton';
import { SETTINGS_TAB_IDS } from '@/lib/settings-tabs';

/**
 * The settings skeleton marks the open page and hides the pages the last
 * session's nav didn't have, both from attributes the boot script sets on
 * <html>. The selectors live in app/boot-skeleton.css as Tailwind variants;
 * read them from there and run them against the rendered rows.
 */
const css = readFileSync(join(process.cwd(), 'app/boot-skeleton.css'), 'utf8');

/** The selector inside `@custom-variant <name> (&:where(<selector>))`. */
function variantSelector(name: string): string {
  const match = css.match(new RegExp(`@custom-variant ${name} \\(&:where\\(([\\s\\S]*?)\\)\\);`));
  if (!match) throw new Error(`no variant ${name}`);
  return match[1].trim();
}

function mount(html: string) {
  document.body.innerHTML = html;
  return document.body;
}

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-boot-settings-tab');
  document.documentElement.removeAttribute('data-boot-settings-tabs');
});

describe('settings skeleton nav', () => {
  it('draws a row for every settings page', () => {
    const root = mount(renderToString(<SettingsSkeleton label="Loading" />));
    const ids = [...root.querySelectorAll('[data-sk-settings-tab]')].map((el) => el.getAttribute('data-sk-settings-tab'));
    expect([...ids].sort()).toEqual([...SETTINGS_TAB_IDS].sort());
  });

  it.each(SETTINGS_TAB_IDS)('highlights only the %s row when that page is open', (tab) => {
    const root = mount(renderToString(<SettingsSkeleton label="Loading" />));
    const active = variantSelector('boot-settings-active');
    document.documentElement.setAttribute('data-boot-settings-tab', tab);
    const rows = [...root.querySelectorAll<HTMLElement>('[data-sk-settings-tab]')];
    const matching = rows.filter((row) => row.matches(active)).map((row) => row.getAttribute('data-sk-settings-tab'));
    expect(matching).toEqual([tab]);
    const row = rows.find((r) => r.getAttribute('data-sk-settings-tab') === tab)!;
    expect(row.className).toContain('boot-settings-active:bg-accent');
  });

  it('hides the optional pages the last nav did not list, and shows recovery only when it did', () => {
    const root = mount(renderToString(<SettingsSkeletonBody />));
    const row = (tab: string) => root.querySelector<HTMLElement>(`[data-sk-settings-tab="${tab}"]`)!;
    const hidesFilters = variantSelector('boot-no-settings-filters');
    const showsRecovery = variantSelector('boot-settings-recovery');
    expect(row('filters').className).toContain('boot-no-settings-filters:hidden');
    expect(row('recovery').className).toContain('boot-settings-recovery:flex');

    // No hints: everything but recovery.
    expect(row('filters').matches(hidesFilters)).toBe(false);
    expect(row('recovery').matches(showsRecovery)).toBe(false);

    document.documentElement.setAttribute('data-boot-settings-tabs', 'account appearance recovery');
    expect(row('filters').matches(hidesFilters)).toBe(true);
    expect(row('recovery').matches(showsRecovery)).toBe(true);

    document.documentElement.setAttribute('data-boot-settings-tabs', 'account filters');
    expect(row('filters').matches(hidesFilters)).toBe(false);
    expect(row('recovery').matches(showsRecovery)).toBe(false);
  });

  it('has the back-to-mail box only outside a Pro pane', () => {
    const page = mount(renderToString(<SettingsSkeleton label="Loading" />));
    expect(page.querySelector('.boot-pro\\:hidden')).not.toBeNull();
    const pane = mount(renderToString(<SettingsSkeletonBody embedded />));
    expect(pane.querySelector('.boot-pro\\:hidden')).toBeNull();
    // A Pro pane is desktop only: no phone list.
    expect(pane.querySelector('.boot-open\\:hidden')).toBeNull();
  });
});
