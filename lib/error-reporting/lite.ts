import type { ClientSettings } from './client';
import { parseDsn } from './envelope';

/**
 * Bulwark Lite has no server: error reporting is set in policy.json and
 * browsers send straight to the DSN. There are no per-day counts.
 *
 *   "errorReporting": { "dsn": "https://<key>@host/<project>", "sampleRate": 1, "environment": "production" }
 *
 * The DSN's host must also be in the CSP's connect-src of the Lite host.
 * https://bulwarkmail.org/docs/deployment/static#error-reporting
 */
export function liteErrorReporting(policy: unknown): ClientSettings | null {
  const raw = policy && typeof policy === 'object' ? (policy as Record<string, unknown>).errorReporting : undefined;
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const dsn = typeof input.dsn === 'string' && parseDsn(input.dsn) ? input.dsn.trim() : '';
  if (!dsn) return null;
  const rate = typeof input.sampleRate === 'number' && Number.isFinite(input.sampleRate) ? Math.min(1, Math.max(0, input.sampleRate)) : 1;
  const environment = typeof input.environment === 'string' && /^[\w.-]{1,64}$/.test(input.environment) ? input.environment : 'production';
  return { dsn, sampleRate: rate, environment, collect: false };
}
