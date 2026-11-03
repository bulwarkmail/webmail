/**
 * Plugin secrets of an account the app dropped, in the desktop app, where they sit
 * on this device's own server. The account has no cookie left to ask with, so the
 * route takes who it was, from what was written down at the time. On an instance
 * they aren't the device's to remove, and nothing is written down.
 */

import { apiFetch } from '@/lib/browser-navigation';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { dropEvictedOwner, readEvictedOwners } from './state';

const BUDGET_MS = 3_000;

/** `account` null: everyone's. */
export async function forgetEvictedSecrets(account: string | null): Promise<void> {
  if (!IS_DESKTOP_BUILD) return;
  const owners = Object.entries(readEvictedOwners()).filter(([id]) => account === null || id === account);
  await Promise.all(owners.map(async ([id, owner]) => {
    const query = new URLSearchParams({ all: 'true', username: owner.username, server: owner.serverUrl });
    const response = await apiFetch(`/api/plugin-secrets?${query}`, { method: 'DELETE', signal: AbortSignal.timeout(BUDGET_MS) }).catch(() => null);
    if (response?.ok) dropEvictedOwner(id);
  }));
}
