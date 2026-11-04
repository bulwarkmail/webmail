import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/settings' }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/settings/about-data-settings', () => ({ AboutFooter: () => null }));
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: false })),
  getPathPrefix: () => '',
  withBasePath: (href: string) => href,
}));

import { AdminShell } from '../admin-shell';

// Turning a tablet round crosses the breakpoint between the shell's two
// layouts. The page used to be remounted there, so what the admin had typed
// and not yet saved was gone without a word.
describe('AdminShell across the desktop breakpoint', () => {
  function mockWidth(initial: boolean) {
    let desktop = initial;
    const listeners = new Set<() => void>();
    window.matchMedia = vi.fn((query: string) => ({
      get matches() { return desktop && query === '(width >= 37.5rem)'; },
      media: query,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    })) as unknown as typeof window.matchMedia;
    return (next: boolean) => act(() => {
      desktop = next;
      listeners.forEach((cb) => cb());
    });
  }

  function Page({ onMount }: { onMount: () => void }) {
    const [value, setValue] = useState('saved');
    useEffect(onMount, [onMount]);
    return <input aria-label="field" value={value} onChange={(e) => setValue(e.target.value)} />;
  }

  it('keeps the page mounted, with its edits, in both directions', () => {
    Element.prototype.scrollTo = () => {};
    const setDesktop = mockWidth(true);
    const onMount = vi.fn();
    render(
      <AdminShell authenticated isStalwartAutoLogin={false} configReadOnly={false} onLogout={() => {}}>
        <Page onMount={onMount} />
      </AdminShell>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'field' }), { target: { value: 'edited' } });

    setDesktop(false);
    expect(screen.getByRole('textbox', { name: 'field' })).toHaveValue('edited');
    setDesktop(true);
    expect(screen.getByRole('textbox', { name: 'field' })).toHaveValue('edited');
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  // On a laptop the list runs past its fold: a page opened from a link used
  // to leave its own entry out of sight.
  it('brings the open page into view in the sidebar', () => {
    Element.prototype.scrollTo = () => {};
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mockWidth(true);
    render(
      <AdminShell authenticated isStalwartAutoLogin={false} configReadOnly={false} onLogout={() => {}}>
        <p>page</p>
      </AdminShell>,
    );
    expect(scrollIntoView.mock.contexts.some((el) => (el as Element).getAttribute('aria-current') === 'page')).toBe(true);
  });
});
