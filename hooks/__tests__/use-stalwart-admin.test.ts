import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const apiFetch = vi.hoisted(() => vi.fn());
const slotHeaders = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));
vi.mock('@/lib/auth/active-account-slot', () => ({ getActiveAccountSlotHeaders: slotHeaders }));

import { useStalwartAdmin } from '../use-stalwart-admin';

const answer = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('useStalwartAdmin', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    slotHeaders.mockReturnValue({ 'X-JMAP-Cookie-Slot': '0' });
  });

  it('is true for a Stalwart admin and mints the session in auto mode', async () => {
    apiFetch.mockResolvedValueOnce(answer({ stalwartAdmin: true, authenticated: false, stalwartAutoLogin: true }));
    apiFetch.mockResolvedValueOnce(answer({}));

    const { result } = renderHook(() => useStalwartAdmin());

    await waitFor(() => expect(result.current).toBe(true));
    expect(apiFetch).toHaveBeenLastCalledWith('/api/admin/auth', expect.objectContaining({ method: 'POST' }));
  });

  it('does not mint a session in password mode', async () => {
    apiFetch.mockResolvedValueOnce(answer({ stalwartAdmin: true, authenticated: false, stalwartAutoLogin: false }));

    const { result } = renderHook(() => useStalwartAdmin());

    await waitFor(() => expect(result.current).toBe(true));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('stays false for other users and without a login slot', async () => {
    apiFetch.mockResolvedValueOnce(answer({ stalwartAdmin: false }));
    const { result } = renderHook(() => useStalwartAdmin());
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(result.current).toBe(false);

    apiFetch.mockReset();
    slotHeaders.mockReturnValue({});
    const { result: noSlot } = renderHook(() => useStalwartAdmin());
    expect(noSlot.current).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
