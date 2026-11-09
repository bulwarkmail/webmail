// The addresses the user let a plugin forward mail to (api.email.forward),
// per plugin and signed-in account, in a key the plugin can't write
// (hostOnlyPluginKey). Settings > Plugins lists them and takes them back.

import { useAccountStore } from '@/stores/account-store';
import { hostOnlyPluginKey } from './storage-scope';

const APPROVALS = 'forward-to';

export function approvalAccount(): string {
  return useAccountStore.getState().activeAccountId ?? 'signed-out';
}

/** The addresses the user let `pluginId` forward to, in this account, lower case. */
export function forwardApprovals(pluginId: string, accountId = approvalAccount()): string[] {
  try {
    const raw = window.localStorage.getItem(hostOnlyPluginKey(pluginId, accountId, APPROVALS));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function saveForwardApprovals(pluginId: string, accountId: string, list: string[]): void {
  const key = hostOnlyPluginKey(pluginId, accountId, APPROVALS);
  try {
    if (list.length) window.localStorage.setItem(key, JSON.stringify([...new Set(list)].sort()));
    else window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: the user is asked again next time.
  }
}

/** Take back the permission to forward to `address`. */
export function revokeForwardApproval(pluginId: string, address: string, accountId = approvalAccount()): void {
  const lower = address.toLowerCase();
  saveForwardApprovals(pluginId, accountId, forwardApprovals(pluginId, accountId).filter((a) => a !== lower));
}
