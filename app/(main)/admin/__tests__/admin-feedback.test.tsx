import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';

// The admin reports what an action did in the app's toasts, like Settings,
// not in a banner under the page header.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast, useToastStore: () => [] }));
let fail = false;
let failLoad = false;
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method && failLoad) return new Response('{}', { status: 500 });
    if (init?.method === 'POST' && fail) {
      return new Response(JSON.stringify({ error: 'not a URL' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      consent: 'off', consentSource: 'file', endpoint: 'https://t.example', defaultEndpoint: 'https://t.example',
      consentedAt: null, lastSentAt: null, nextScheduledAt: null, payloadPreview: {}, accountCounts: { total: 0, active7d: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }),
  withBasePath: (p: string) => p,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

import { TelemetryPage } from '../_pages/telemetry';

afterEach(() => {
  fail = false;
  failLoad = false;
  toast.success.mockClear();
  toast.error.mockClear();
  useAdminUnsavedStore.setState({ dirty: {}, pendingLeave: null, pendingScope: null });
});

async function saveEndpoint(value: string) {
  render(<TelemetryPage />);
  fireEvent.change(await screen.findByLabelText('Collector URL'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('admin feedback', () => {
  // A failed load left the page on its loading skeleton for good.
  it('says a page could not load and offers to try again', async () => {
    failLoad = true;
    render(<TelemetryPage />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText('Could not load the usage stats')).toBeTruthy();

    failLoad = false;
    fireEvent.click(retry);
    expect(await screen.findByLabelText('Collector URL')).toBeTruthy();
  });

  it('says a save worked in a success toast, with no banner', async () => {
    await saveEndpoint('https://collector.example');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Telemetry settings saved.'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says a save failed in an error toast', async () => {
    fail = true;
    await saveEndpoint('nope');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't save: Endpoint: not a URL"));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
