import { NextResponse } from 'next/server';
import { bootState } from './index';

const MESSAGES = {
  starting: 'Bulwark is starting and connecting to its shared store.',
  'store-lost': 'Bulwark lost its shared store data and is waiting for it to be restored.',
  blocked: 'This Bulwark instance has local data that conflicts with the shared store. See the server log.',
} as const;

/**
 * 503 for every request while this replica can't serve (shared mode only:
 * local mode is always ready). The proxy calls it for everything but the
 * health and readiness probes; the three upload routes the proxy skips call
 * it themselves.
 */
export function bootGateResponse(pathname?: string): NextResponse | null {
  const state = bootState();
  if (state === 'ready') return null;
  const message = MESSAGES[state];
  const headers = { 'Retry-After': '5', 'Cache-Control': 'no-store' };
  if (!pathname || pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'not_ready', state, message }, { status: 503, headers });
  }
  return new NextResponse(message, { status: 503, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
}
