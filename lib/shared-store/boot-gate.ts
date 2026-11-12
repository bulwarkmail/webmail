import { NextResponse } from 'next/server';
import { bootState, storeRefusal } from './index';

const MESSAGES = {
  starting: 'Bulwark is starting and connecting to its shared store.',
  'store-lost': 'Bulwark lost its shared store data and is waiting for it to be restored.',
  blocked: 'This Bulwark instance has local data that conflicts with the shared store. See the server log.',
  refused:
    'Bulwark does not use its shared store because the store address has no password. Set a password in ' +
    'REDIS_URL, or set SHARED_STORE_ALLOW_NO_PASSWORD=true if only this deployment can reach the store.',
} as const;

const INVALID_URL =
  'Bulwark does not use its shared store because REDIS_URL is not a valid URL. A password with / ? # @ or % ' +
  'in it has to be percent-encoded.';

/**
 * 503 for every request while this replica can't serve (shared mode only:
 * local mode is always ready). The proxy calls it for everything but the
 * health and readiness probes; the three upload routes the proxy skips call
 * it themselves. The messages are plain English text, like the rest of this
 * answer; they name the setting to change, never the store's address.
 */
export function bootGateResponse(pathname?: string): NextResponse | null {
  const state = bootState();
  if (state === 'ready') return null;
  const message = state === 'refused' && storeRefusal() === 'invalid-url' ? INVALID_URL : MESSAGES[state];
  const headers = { 'Retry-After': '5', 'Cache-Control': 'no-store' };
  if (!pathname || pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'not_ready', state, message }, { status: 503, headers });
  }
  return new NextResponse(message, { status: 503, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
}
