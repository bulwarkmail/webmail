import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// While the admin session is checked, the content column shows the page's
// header and section placeholders where the boot skeleton drew them, not a
// line of text at a different height.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/admin/settings',
}));
vi.mock('@/lib/browser-navigation', () => ({
  // The session check never answers.
  apiFetch: vi.fn(() => new Promise(() => {})),
  getPathPrefix: () => '',
  withBasePath: (href: string) => href,
}));
vi.mock('@/components/admin/admin-shell', () => ({
  AdminShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../_unsaved-changes-guard', () => ({ UnsavedChangesGuard: () => null }));

const { AdminLayoutClient } = await import('../_layout-client');

describe('admin layout while the session is checked', () => {
  it('draws the page header and section placeholders in the content slot', () => {
    render(<AdminLayoutClient><p>page</p></AdminLayoutClient>);
    const main = screen.getByRole('main');
    expect(main.querySelector('[data-testid="admin-body-skeleton"]')).not.toBeNull();
    // The open page's own title and description, as AdminPageHeader shows them.
    expect(main.textContent).toContain('How this Bulwark connects and what the login page offers');
    expect(screen.getByRole('status').textContent).toBe('Loading admin panel…');
    expect(screen.getByRole('status').className).toContain('sr-only');
    expect(screen.queryByText('page')).toBeNull();
  });
});
