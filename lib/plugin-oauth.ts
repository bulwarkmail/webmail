/**
 * Shared constants and types for the plugin OAuth callback handoff.
 *
 * The callback page (`/[locale]/plugins/oauth/callback`) parks the provider's
 * payload in storage and dispatches events; the host relays it to plugins via
 * the `authHooks.onOAuthCallback` hook bus. Both sides share the storage key,
 * event name and payload contract from this module.
 */

export const PLUGIN_OAUTH_STORAGE_KEY = "plugin-oauth-callback";
export const PLUGIN_OAUTH_EVENT = "plugin-oauth-callback";

/**
 * Payload delivered to plugins through `authHooks.onOAuthCallback`.
 *
 * Two shapes, discriminated by which field the provider returned:
 * - Success: `{ code, state?, receivedAt? }`
 * - Denial/failure: `{ error, state?, error_description?, receivedAt? }`
 *
 * `state` stays optional in both variants because a provider may omit it even
 * on error; plugins match the flow against the verifier they stashed before
 * redirecting and ignore payloads whose `state` does not match. Narrow with
 * `'code' in payload` / `'error' in payload`.
 */
export type OAuthCallbackPayload =
    | { code: string; state?: string; receivedAt?: number }
    | {
        error: string;
        state?: string;
        error_description?: string;
        receivedAt?: number;
    };

// ─── State values bound to the plugin that started the flow ───

const STATES_KEY = "plugin-oauth-states";
/** A flow that takes longer than this is abandoned. */
const STATE_TTL_MS = 15 * 60_000;

type StateTable = Record<string, { pluginId: string; created: number }>;

function readStates(): StateTable {
  try {
    const raw = localStorage.getItem(STATES_KEY);
    const parsed = raw ? JSON.parse(raw) as StateTable : {};
    const now = Date.now();
    for (const [state, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry.pluginId !== "string" || now - entry.created > STATE_TTL_MS) delete parsed[state];
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeStates(table: StateTable): void {
  try { localStorage.setItem(STATES_KEY, JSON.stringify(table)); } catch { /* storage blocked */ }
}

/**
 * A fresh `state` for a plugin's OAuth redirect. The callback is delivered
 * only to the plugin that asked for this value; before, every plugin with
 * http:fetch received every code. Kept in localStorage so the tab that gets
 * the callback event finds it even if another tab started the flow.
 */
export function createOAuthState(pluginId: string): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const table = readStates();
  table[state] = { pluginId, created: Date.now() };
  writeStates(table);
  return state;
}

const CALLBACK_PATH = /^(?:\/[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?\/plugins\/oauth\/callback\/?$/;

/**
 * Whether `url` starts this plugin's own OAuth sign-in: its one redirect_uri is this origin's
 * plugin callback, and its `state` is one the plugin got from `oauth.createState`. A link in a
 * message can't carry such a state. Nothing is consumed.
 */
export function isPluginSignIn(url: URL, pluginId: string, origin: string = window.location.origin): boolean {
  const redirects = url.searchParams.getAll("redirect_uri");
  if (redirects.length !== 1) return false;
  let target: URL;
  try { target = new URL(redirects[0]); } catch { return false; }
  if (target.origin !== origin || !CALLBACK_PATH.test(target.pathname)) return false;
  const state = url.searchParams.get("state");
  return !!state && readStates()[state]?.pluginId === pluginId;
}

/** The plugin a callback belongs to, consumed so it can't be delivered twice. */
export function takeOAuthStateOwner(state: string | undefined): string | null {
  if (!state) return null;
  const table = readStates();
  const entry = table[state];
  if (!entry) return null;
  delete table[state];
  writeStates(table);
  return entry.pluginId;
}
