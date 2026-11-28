import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';

// A domain's palette (DOMAIN_BRANDING `palette`): saving or reverting
// another field of that domain must still send the palette back, or the
// PATCH would wipe it; the Button colours fields edit it (#1901).

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

describe('branding page edits a domain palette (#1901)', () => {
  async function openDomain() {
    render(<BrandingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'mail.example.com' }));
  }

  it('shows the domain\'s colours and saves a changed one into its palette, the others kept', async () => {
    await openDomain();
    expect(screen.getByRole('textbox', { name: 'Button colour (light mode)' })).toHaveValue('#0b3d91');
    expect(screen.getByRole('textbox', { name: 'Button colour (dark mode)' })).toHaveValue('#7cc4ff');
    fireEvent.change(screen.getByRole('textbox', { name: 'Button text (light mode)' }), { target: { value: ' #FFEEDD ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Highlight colour (dark mode)' }), { target: { value: '#123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(lastPatch().domainBranding).toEqual([{
      host: 'mail.example.com',
      loginCompanyName: 'Acme',
      palette: { light: { primary: '#0b3d91', 'primary-foreground': '#ffeedd' }, dark: { primary: '#7cc4ff', accent: '#123' } },
    }]));
  });

  it('refuses to save a colour that is not hex', async () => {
    await openDomain();
    const field = screen.getByRole('textbox', { name: 'Highlight text (light mode)' });
    fireEvent.change(field, { target: { value: 'red' } });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('drops a reverted colour, and the palette once it is empty', async () => {
    await openDomain();
    const light = screen.getByRole('textbox', { name: 'Button colour (light mode)' });
    fireEvent.click(light.parentElement!.querySelector('button[aria-label="Revert to default"]') as HTMLElement);
    await waitFor(() => expect(lastPatch().domainBranding).toEqual([
      { host: 'mail.example.com', loginCompanyName: 'Acme', palette: { dark: { primary: '#7cc4ff' } } },
    ]));
  });

  it('previews the colours on the light and dark surfaces, the built-in ones where nothing is set', async () => {
    await openDomain();
    const preview = screen.getByTestId('branding-palette-preview');
    const button = preview.querySelector('[data-preview-button="light"]') as HTMLElement;
    expect(button.style.background).toBe('rgb(11, 61, 145)');
    expect(button.style.color).toBe('rgb(255, 255, 255)');
    fireEvent.change(screen.getByRole('textbox', { name: 'Button colour (light mode)' }), { target: { value: '#ff0000' } });
    expect(button.style.background).toBe('rgb(255, 0, 0)');
  });

  it('asks for a domain in the Default scope', async () => {
    render(<BrandingPage />);
    expect(await screen.findByTestId('branding-colors-default')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Button colour (light mode)' })).toBeNull();
  });
});
