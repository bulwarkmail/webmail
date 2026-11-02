import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AppShellSkeleton } from '../shell';
import { ProSkeleton } from '../pro-skeleton';

// The Pro interface takes a standard page over on a desktop (redirect to
// /pro after mount). The page's skeleton has to be the Pro frame from the
// first paint, or the hop moves everything. The swap is CSS on attributes the
// boot script sets; these tests pin the markup the CSS works on.

function html(element: React.ReactElement) {
  const container = document.createElement('div');
  container.innerHTML = renderToString(element);
  return container;
}

const classes = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/);

describe('AppShellSkeleton under the Pro interface', () => {
  const page = () =>
    html(
      <AppShellSkeleton surface="calendar" label="Loading" railBelow="md" active="calendar">
        <div data-testid="calendar-body" />
      </AppShellSkeleton>,
    );

  it('draws the Pro frame next to the standard one, swapped by boot-pro-frame', () => {
    const container = page();
    const pro = container.querySelector('[data-boot-skeleton="pro"]');
    const standard = container.querySelector('[data-boot-skeleton="calendar"]');
    expect(pro).not.toBeNull();
    expect(standard).not.toBeNull();
    // Hidden unless Pro takes over; the standard frame hides when it does.
    expect(classes(pro?.parentElement)).toEqual(expect.arrayContaining(['hidden', 'boot-pro-frame:block']));
    expect(classes(standard)).toEqual(expect.arrayContaining(['boot-pro-frame:hidden', 'boot-out:hidden']));
    // The page's own body stays in the standard frame only.
    expect(pro?.querySelector('[data-testid="calendar-body"]')).toBeNull();
    expect(standard?.querySelector('[data-testid="calendar-body"]')).not.toBeNull();
  });

  it('gives the Pro frame the shell root, the rail with search, and two panes', () => {
    const pro = page().querySelector('[data-boot-skeleton="pro"]');
    expect(classes(pro)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'h-dvh']));
    const shell = pro?.querySelector('[data-pro-shell]');
    const rail = shell?.firstElementChild;
    expect(classes(rail)).toEqual(expect.arrayContaining(['w-14', 'flex']));
    expect(rail?.querySelectorAll('[data-sk-rail]')).toHaveLength(5);
    const panes = pro?.querySelectorAll('[data-sk-pro-pane]') ?? [];
    expect([...panes].map((p) => p.getAttribute('data-sk-pro-pane'))).toEqual(['main', 'split']);
    for (const pane of panes) {
      // The tab strip, with eight tab slots for the CSS to pick from, right
      // above the pane body.
      const [strip, body] = [...pane.children];
      expect(strip.querySelectorAll('[data-sk-pro-tab]')).toHaveLength(8);
      expect(classes(strip)).toEqual(expect.arrayContaining(['h-9', 'bg-secondary']));
      // A page Pro takes over only draws its own body: the redirect focuses
      // its tab. (The /pro page draws all of them, see ProSkeleton below.)
      expect([...body.children].map((b) => b.getAttribute('data-sk-pro-body'))).toEqual(['calendar', 'other']);
    }
    // The split pane only shows with a split.
    expect(classes(panes[1])).toEqual(expect.arrayContaining(['hidden', 'boot-pro-split:flex']));
  });

  it('lets the login card win for a signed-out visitor', () => {
    const container = page();
    const login = container.querySelector('[data-boot-skeleton="login"]');
    expect(classes(login?.parentElement)).toEqual(expect.arrayContaining(['hidden', 'boot-out:block']));
  });
});

describe('ProSkeleton', () => {
  it('is the Pro frame, or the login card for a signed-out visitor', () => {
    const container = html(<ProSkeleton label="Loading" />);
    const pro = container.querySelector('[data-boot-skeleton="pro"]');
    expect(classes(pro)).toContain('boot-out:hidden');
    expect(pro?.querySelector('[data-pro-shell]')).not.toBeNull();
    expect(container.querySelector('[data-boot-skeleton="login"]')).not.toBeNull();
  });

  it('draws every page body in both panes on /pro, where the stored tabs decide', () => {
    const container = html(<ProSkeleton label="Loading" />);
    for (const pane of container.querySelectorAll('[data-sk-pro-pane]')) {
      const body = pane.children[1];
      expect([...body.children].map((b) => b.getAttribute('data-sk-pro-body'))).toEqual([
        'mail', 'calendar', 'contacts', 'files', 'settings', 'other',
      ]);
    }
  });
});

describe('the Pro CSS picks the stored tabs and pages', () => {
  // The "pro" section of app/boot-skeleton.css, minus the Tailwind variants,
  // applied to the real markup with the attributes the boot script sets.
  const css = readFileSync(path.resolve(__dirname, '../../../app/boot-skeleton.css'), 'utf8')
    .split('/* pro */')[1]
    .replace(/@custom-variant[^;]*;/g, '');

  let container: HTMLElement;
  beforeEach(() => {
    const style = document.createElement('style');
    style.id = 'pro-css';
    style.textContent = css;
    document.head.appendChild(style);
    container = document.createElement('div');
    container.innerHTML = renderToString(<ProSkeleton label="Loading" />);
    document.body.appendChild(container);
  });
  afterEach(() => {
    document.getElementById('pro-css')?.remove();
    container.remove();
    for (const a of [...document.documentElement.attributes]) {
      if (a.name.startsWith('data-boot-')) document.documentElement.removeAttribute(a.name);
    }
  });

  const boot = (attrs: Record<string, string>) => {
    for (const [k, v] of Object.entries(attrs)) document.documentElement.setAttribute(`data-boot-${k}`, v);
  };
  const pane = (which: string) => container.querySelector(`[data-sk-pro-pane="${which}"]`)!;
  const shown = (els: Iterable<Element>) => [...els].filter((el) => getComputedStyle(el).display !== 'none');
  const tabs = (which: string) => shown(pane(which).querySelectorAll('[data-sk-pro-tab]'));
  const active = (which: string) =>
    [...pane(which).querySelectorAll('[data-sk-pro-tab]')].findIndex(
      (el) => !['', 'transparent', 'rgba(0, 0, 0, 0)'].includes(getComputedStyle(el).backgroundColor),
    );
  const body = (which: string) =>
    shown(pane(which).querySelectorAll('[data-sk-pro-body]')).map((el) => el.getAttribute('data-sk-pro-body'));

  it('draws one active mail tab without attributes', () => {
    expect(tabs('main')).toHaveLength(1);
    expect(active('main')).toBe(0);
    expect(body('main')).toEqual(['mail']);
  });

  it('draws the stored count, the active tab and its page in each pane', () => {
    boot({ pro: 'on', 'pro-main-tabs': '3', 'pro-main-active': '2', 'pro-main-kind': 'calendar', 'pro-split-tabs': '2', 'pro-split-active': '0', 'pro-split-kind': 'other', 'pro-split': 'right' });
    expect(tabs('main')).toHaveLength(3);
    expect(active('main')).toBe(2);
    expect(body('main')).toEqual(['calendar']);
    expect(tabs('split')).toHaveLength(2);
    expect(active('split')).toBe(0);
    expect(body('split')).toEqual(['other']);
  });
});
