import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { RouteSkeleton } from '../route-skeleton';
import type { BootSurface } from '@/lib/boot-skeleton/surfaces';

/**
 * Every page skeleton is rendered by the server and then hydrated by the same
 * component on the client. They must produce identical markup, or React throws
 * the server HTML away and the page flashes.
 */

const SURFACES: BootSurface[] = [
  'mail', 'calendar', 'contacts', 'files', 'apps', 'settings', 'pro', 'admin', 'admin-login', 'login', 'setup',
];

const LABELS = { mail: 'Mail', calendar: 'Calendar', contacts: 'Contacts', files: 'Files', settings: 'Settings' };

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('page skeletons hydrate without a mismatch', () => {
  it.each(SURFACES)('%s', async (surface) => {
    const element = <RouteSkeleton surface={surface} label="Loading..." labels={LABELS} />;
    const html = renderToString(element);
    expect(html).toContain(`data-boot-skeleton="${surface === 'admin-login' ? 'login' : surface}"`);

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });
    await act(async () => {
      hydrateRoot(container, element, { onRecoverableError: (e) => { errors.push(e); } });
    });
    consoleError.mockRestore();
    expect(errors).toEqual([]);
    expect(container.innerHTML).toBe(html);
  });

  it.each(SURFACES)('%s: one status message, busy, and nothing focusable', (surface) => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(<RouteSkeleton surface={surface} label="Loading..." labels={LABELS} />);
    // A signed-in page also carries the login card for signed-out visitors,
    // hidden by CSS; count per region.
    for (const region of container.querySelectorAll('[data-boot-skeleton]')) {
      expect(region.getAttribute('aria-busy')).toBe('true');
      expect(region.querySelectorAll('[role="status"]').length).toBeLessThanOrEqual(1);
    }
    expect(container.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')).toHaveLength(0);
    for (const shape of container.querySelectorAll('.sk-shape')) {
      expect(shape.closest('[aria-hidden="true"]'), shape.outerHTML).not.toBeNull();
    }
  });
});
