import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';

// Saving, uploading or checking reloads the page's data. The pages used to
// put the loading skeleton back for that reload, which unmounted the whole
// page and dropped the admin back at the top of it.

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch,
  withBasePath: (p: string) => p,
  getPathPrefix: () => '',
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast, useToastStore: () => [] }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

import { BrandingPage } from '../_pages/branding';
import { SettingsPage } from '../_pages/settings';
import { VersionPage } from '../_pages/version';

// Answers the first load at once and holds every later one until released,
// so the test can look at the page while it reloads.
function holdReloads(answer: (init?: RequestInit) => unknown) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let loads = 0;
  apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return json({ ok: true });
    if (loads++ > 0) await held;
    return json(answer(init));
  });
  return { release: () => act(async () => { release(); }) };
}

const config = () => ({
  appName: { source: 'admin', value: 'Mail' },
  domainBranding: { source: 'admin', value: [] },
});

async function startReload(button: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  await act(async () => {});
}

afterEach(() => {
  apiFetch.mockReset();
  useAdminUnsavedStore.setState({ dirty: {}, pendingLeave: null, pendingScope: null });
});

describe('admin pages keep their content while reloading', () => {
  it('settings: the field stays mounted through the reload after a save', async () => {
    const { release } = holdReloads(config);
    render(<SettingsPage />);
    const name = await screen.findByRole('textbox', { name: 'Application name' });
    fireEvent.change(name, { target: { value: 'Mail2' } });
    await startReload(/Save changes/);
    expect(name).toBeInTheDocument();
    await release();
    expect(screen.getByRole('textbox', { name: 'Application name' })).toBe(name);
  });

  it('branding: the field stays mounted through the reload after a save', async () => {
    const { release } = holdReloads(config);
    render(<BrandingPage />);
    const company = await screen.findByRole('textbox', { name: 'Company name' });
    fireEvent.change(company, { target: { value: 'Acme' } });
    await startReload(/Save changes/);
    expect(company).toBeInTheDocument();
    await release();
    expect(screen.getByRole('textbox', { name: 'Company name' })).toBe(company);
  });

  it('version: the status stays mounted through the reload after "Check now"', async () => {
    const { release } = holdReloads(() => ({
      current: '1.21.0', build: 'abc', endpoint: '', defaultEndpoint: '', disabledByEnv: false,
      lastCheckedAt: null, lastSuccessAt: null, nextScheduledAt: null, status: null,
    }));
    render(<VersionPage />);
    const running = await screen.findByText('1.21.0');
    await startReload(/Check now/);
    expect(running).toBeInTheDocument();
    await release();
    expect(screen.getByText('1.21.0')).toBe(running);
  });
});
