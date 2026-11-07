import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';

// A domain's palette has no field on the branding page yet. Saving or
// reverting another field of that domain must still send the palette back,
// or the PATCH would wipe it.

const palette = { light: { primary: '#0b3d91' }, dark: { primary: '#7cc4ff' } };

vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    domainBranding: {
      source: 'admin',
      value: [{ host: 'mail.example.com', loginCompanyName: 'Acme', palette }],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })),
  withBasePath: (p: string) => p,
  getPathPrefix: () => '',
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast, useToastStore: () => [] }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

import { apiFetch } from '@/lib/browser-navigation';
import { BrandingPage } from '../_pages/branding';

afterEach(() => {
  vi.mocked(apiFetch).mockClear();
  useAdminUnsavedStore.setState({ dirty: {}, pendingLeave: null, pendingScope: null });
});

/** Body of the last PATCH to /api/admin/config. */
function lastPatch(): { domainBranding?: unknown } {
  const call = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH').at(-1);
  expect(call).toBeDefined();
  return JSON.parse(String(call![1]!.body));
}

describe('branding page keeps a domain palette', () => {
  it('when another field of the domain is saved', async () => {
    render(<BrandingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'mail.example.com' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), { target: { value: 'Acme Two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(lastPatch().domainBranding).toEqual([
      { host: 'mail.example.com', loginCompanyName: 'Acme Two', palette },
    ]));
  });

  it('when another field of the domain is reverted', async () => {
    render(<BrandingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'mail.example.com' }));
    const company = screen.getByRole('textbox', { name: 'Company name' });
    const revert = company.parentElement!.querySelector('button[aria-label="Revert to default"]') as HTMLElement;
    fireEvent.click(revert);
    await waitFor(() => expect(lastPatch().domainBranding).toEqual([
      { host: 'mail.example.com', palette },
    ]));
  });
});
