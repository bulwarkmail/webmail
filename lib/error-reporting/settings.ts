import { configManager } from '@/lib/admin/config-manager';
import { parseDsn } from './envelope';
import { metricsEnabled } from '@/lib/metrics';
import { effectiveErrorsConsent } from '@/lib/telemetry/state';
import type { ClientSettings } from './client';

/**
 * The error-reporting settings as the server resolves them: admin config,
 * then ERROR_REPORTING_DSN(_FILE) / ERROR_REPORTING_SAMPLE_RATE /
 * ERROR_REPORTING_ENVIRONMENT, then off. Bulwark Lite reads the same three
 * from policy.json (lib/error-reporting/lite.ts).
 */

export interface ErrorReportingSettings {
  /** A valid DSN, or '' when none is set or the value doesn't parse. */
  dsn: string;
  sampleRate: number;
  environment: string;
}

export function parseSampleRate(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export function parseEnvironment(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[\w.-]{1,64}$/.test(text) ? text : 'production';
}

export function errorReportingSettings(): ErrorReportingSettings {
  const raw = configManager.get<string>('errorReportingDsn', '');
  return {
    dsn: parseDsn(raw) ? raw.trim() : '',
    sampleRate: parseSampleRate(configManager.get<string>('errorReportingSampleRate', '1')),
    environment: parseEnvironment(configManager.get<string>('errorReportingEnvironment', 'production')),
  };
}

/**
 * Whether browsers should post their errors to /api/errors: when there is a
 * DSN to report to, a metrics endpoint that counts them, or consent to send
 * error counts with the telemetry heartbeat.
 */
export async function shouldCollectErrors(): Promise<boolean> {
  await configManager.ensureLoaded();
  if (errorReportingSettings().dsn || metricsEnabled()) return true;
  return (await effectiveErrorsConsent()).consent !== 'off';
}

/** What /api/config hands the browser. */
export async function browserErrorSettings(): Promise<ClientSettings> {
  const settings = errorReportingSettings();
  return { ...settings, collect: await shouldCollectErrors() };
}
