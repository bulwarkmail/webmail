import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Users have no way to upload a theme (nothing calls the theme store's
// installTheme), so the admin switch that allowed it did nothing.

vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (url: string) => {
    const data = url.startsWith('/api/admin/policy') ? { features: { userThemesEnabled: false }, themePolicy: {} } : [];
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }),
  withBasePath: (p: string) => p,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../_pages/use-extension-icons', () => ({ useExtensionIcons: () => () => null }));

import { ThemesPage } from '../_pages/themes';

describe('admin themes policy', () => {
  it('has no switch for user theme uploads, which users cannot do', async () => {
    render(<ThemesPage />);
    expect(await screen.findByText('Allow users to select and apply themes')).toBeInTheDocument();
    expect(screen.queryByText('Users may upload themes')).toBeNull();
  });
});
