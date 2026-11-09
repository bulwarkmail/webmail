import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RouteSkeleton } from '../route-skeleton';
import { BottomBarSkeleton, RailSkeleton } from '../shell';
import { AdminSkeleton } from '../admin-skeleton';
import type { BootSurface } from '@/lib/boot-skeleton/surfaces';

function dom(html: string) {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

const css = readFileSync(join(process.cwd(), 'app/boot-skeleton.css'), 'utf8');

// A signed-in page drawn for a visitor with nothing stored: the boot script
// sets data-boot-auth="out", and the CSS swaps the app's frame for the
// login card, the page the app is about to send them to.
describe('signed-in pages for a signed-out visitor', () => {
  it('boot-out matches data-boot-auth="out"', () => {
    expect(css).toMatch(/@custom-variant boot-out \(&:where\(\[data-boot-auth="out"\] \*\)\);/);
  });

  it.each<BootSurface>(['mail', 'calendar', 'contacts', 'files', 'apps', 'settings'])('%s carries the login card, shown only with boot-out', (surface) => {
    const container = dom(renderToString(<RouteSkeleton surface={surface} label="Loading" />));
    const login = container.querySelector('[data-boot-skeleton="login"]');
    expect(login).not.toBeNull();
    // Hidden unless the page is marked signed out.
    expect(login!.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'boot-out:block']));
    // The card itself, in the login page's frame: two fields and the button.
    expect(login!.querySelector('.login-frame .login-card')).not.toBeNull();
    expect(login!.querySelectorAll('.login-card .h-10').length).toBeGreaterThanOrEqual(3);
    // And the accessibility button the login page will have in its corner.
    expect(login!.querySelector('.fixed.bottom-4.end-4')).not.toBeNull();
    // And the app's own frame goes away then.
    const app = container.querySelector(`[data-boot-skeleton="${surface}"]`);
    expect(app!.className.split(' ')).toContain('boot-out:hidden');
  });
});

describe('login skeleton', () => {
  // The login page renders the real accessibility button itself.
  it('leaves the accessibility button to the login page', () => {
    const container = dom(renderToString(<RouteSkeleton surface="login" label="Loading" />));
    expect(container.querySelector('.fixed')).toBeNull();
  });
});

describe('admin skeleton', () => {
  it('draws the page list with its real names and the open page current', () => {
    const container = dom(renderToString(<AdminSkeleton page="branding" label="Loading" />));
    const text = container.textContent ?? '';
    for (const name of ['Overview', 'Server', 'Branding', 'Users', 'Features and settings', 'Extensions', 'System', 'Audit log']) {
      expect(text).toContain(name);
    }
    const current = [...container.querySelectorAll('.bg-accent')].map((el) => el.textContent);
    expect(current).toEqual(['Branding']);
  });

  it('shows the phone list at /admin and the page below it', () => {
    const index = dom(renderToString(<AdminSkeleton page={null} />));
    const detail = dom(renderToString(<AdminSkeleton page="logs" />));
    const phone = (c: HTMLElement) => c.querySelector('.desk\\:hidden')!;
    // Index: the list (with its chevrons) is shown, the page column hidden.
    expect(phone(index).querySelector('.p-4')!.className).toContain('hidden');
    expect(phone(detail).querySelector('.p-4')!.className).not.toContain('hidden');
    // Unknown page (a connector link): the boot script's pane attribute decides.
    const unknown = dom(renderToString(<AdminSkeleton />));
    expect(phone(unknown).querySelector('.p-4')!.className).toContain('boot-open:block');
  });
});

describe('rail with the admin panel current', () => {
  it('always draws the admin entry, as current', () => {
    const rail = dom(renderToString(<RailSkeleton active="admin" />));
    const shield = rail.querySelector('.bg-primary\\/10')!;
    expect(shield).not.toBeNull();
    expect(shield.className).not.toContain('hidden');
    // Without it, only the last session's hint shows the entry.
    const plain = dom(renderToString(<RailSkeleton active="mail" />));
    expect(plain.innerHTML).toContain('boot-rail-admin:flex');
  });

  it('has no account or quota circle: the admin panel has no mailbox', () => {
    const circles = (html: string) => dom(html).querySelectorAll('.rounded-full.w-8.h-8').length;
    expect(circles(renderToString(<RailSkeleton active="admin" />))).toBe(0);
    expect(circles(renderToString(<RailSkeleton active="mail" />))).toBe(2);
  });

  it('adds Admin to the bottom bar before Settings', () => {
    const bar = dom(renderToString(<BottomBarSkeleton active="admin" labels={{ mail: 'Mail', admin: 'Admin', settings: 'Settings' }} />));
    const labels = [...bar.querySelectorAll('span.truncate')].map((el) => el.textContent);
    expect(labels.slice(-2)).toEqual(['Admin', 'Settings']);
    const plain = dom(renderToString(<BottomBarSkeleton active="mail" labels={{ admin: 'Admin' }} />));
    expect(plain.textContent).not.toContain('Admin');
  });
});
