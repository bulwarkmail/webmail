// Host-side "Connect account" requests. A plugin asks to connect one of the
// user-scope credentials its manifest declares (api.proxy.connect); the host
// shows its own dialog naming the plugin and the server, the user types the
// password there, and it goes straight to /api/plugin-secrets. For a
// credential that declares `appPassword` the user only confirms, and the
// server makes an app password. The plugin only learns whether the account
// is connected.

import type { UserCredentialSpec } from '@/lib/plugin-secrets/credentials';
import { apiFetch } from '../browser-navigation';

export interface ConnectRequest {
  id: string;
  pluginId: string;
  pluginName: string;
  credentialId: string;
  spec: UserCredentialSpec;
  /**
   * `password`: the user types a password or key here.
   * `signin`: only the server is approved here; the plugin then runs a
   * sign-in flow whose answer the proxy captures (Nextcloud Login Flow v2).
   * `appPassword`: the user confirms, the server makes an app password on
   * the mail account they are signed in to.
   */
  mode: 'password' | 'signin' | 'appPassword';
  /** Server address to suggest when the manifest leaves it to the user. */
  suggestedOrigin?: string;
  suggestedUsername?: string;
  resolve: (result: ConnectResult) => void;
}

export type ConnectResult = { connected: boolean; origin?: string };

let current: ConnectRequest | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function subscribeConnect(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function currentConnect(): ConnectRequest | null {
  return current;
}

export class ConnectBusyError extends Error {
  constructor() {
    super('Another account connection is already open');
  }
}

/** Ask the user to connect an account. One request at a time, app-wide. */
export function requestConnect(input: Omit<ConnectRequest, 'id' | 'resolve'>): Promise<ConnectResult> {
  if (current) return Promise.reject(new ConnectBusyError());
  return new Promise<ConnectResult>((resolve) => {
    current = {
      ...input,
      id: Math.random().toString(36).slice(2),
      resolve: (result) => {
        current = null;
        notify();
        resolve(result);
      },
    };
    notify();
  });
}

/** Close an open request of this plugin (it was turned off or removed). */
export function cancelConnectFor(pluginId: string): void {
  if (current?.pluginId === pluginId) current.resolve({ connected: false });
}

export type SaveCredentialInput = {
  pluginId: string;
  credentialId: string;
  label: string;
} & (
  | { origin: string; inject: UserCredentialSpec['inject']; username?: string; secret?: string }
  | { appPassword: true }
);

/** POST to /api/plugin-secrets. Returns an error message, or null. */
export async function saveCredential(input: SaveCredentialInput): Promise<string | null> {
  const res = await apiFetch('/api/plugin-secrets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (res.ok) return null;
  try {
    const body = await res.json() as { error?: string };
    return body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Remove a plugin's stored credentials (all of them without credentialId). */
export async function forgetCredentials(pluginId: string, credentialId?: string): Promise<boolean> {
  const query = new URLSearchParams({ plugin: pluginId, ...(credentialId ? { credential: credentialId } : {}) });
  try {
    const res = await apiFetch(`/api/plugin-secrets?${query}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ConnectedAccount {
  pluginId: string;
  credentialId: string;
  label: string;
  origin: string;
  username?: string;
  connected: boolean;
  updatedAt: string;
}

export async function listConnectedAccounts(pluginId?: string): Promise<ConnectedAccount[]> {
  return (await credentialOverview(pluginId)).credentials;
}

export interface CredentialOverview {
  credentials: ConnectedAccount[];
  admin: { credentialId: string; configured: boolean }[];
  /** Servers of the admin credentials that are set up. For the host page only. */
  adminOrigins: string[];
}

/** The user's connected accounts, and (for one plugin) which admin credentials are set up. */
export async function credentialOverview(pluginId?: string): Promise<CredentialOverview> {
  const query = pluginId ? `?plugin=${encodeURIComponent(pluginId)}` : '';
  try {
    const res = await apiFetch(`/api/plugin-secrets${query}`);
    if (!res.ok) return { credentials: [], admin: [], adminOrigins: [] };
    const body = await res.json() as Partial<CredentialOverview>;
    return {
      credentials: Array.isArray(body.credentials) ? body.credentials : [],
      admin: Array.isArray(body.admin) ? body.admin : [],
      adminOrigins: Array.isArray(body.adminOrigins) ? body.adminOrigins.filter((o): o is string => typeof o === 'string') : [],
    };
  } catch {
    return { credentials: [], admin: [], adminOrigins: [] };
  }
}

/** Normalise what the user typed into an origin, adding https:// if missing. */
export function originFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
