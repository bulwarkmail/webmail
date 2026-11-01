import { describe, expect, it } from 'vitest';
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
      // Tab strip right above the pane body, eight tab slots for the CSS to pick from.
      expect(pane.previousElementSibling?.querySelectorAll('[data-sk-pro-tab]')).toHaveLength(8);
      expect(classes(pane.previousElementSibling)).toEqual(expect.arrayContaining(['h-9', 'bg-secondary']));
      expect([...pane.children].map((b) => b.getAttribute('data-sk-pro-body'))).toEqual([
        'mail', 'calendar', 'contacts', 'files', 'settings', 'other',
      ]);
    }
    // The split pane only shows with a split.
    expect(classes(panes[1]?.parentElement)).toEqual(expect.arrayContaining(['hidden', 'boot-pro-split:flex']));
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
});
