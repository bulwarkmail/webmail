/**
 * Whether OpenTelemetry tracing is configured, from the standard OTEL_*
 * variables only: an OTLP endpoint (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or
 * OTEL_EXPORTER_OTLP_ENDPOINT), unless OTEL_SDK_DISABLED=true or
 * OTEL_TRACES_EXPORTER=none. Without it the SDK is never loaded.
 *
 * https://bulwarkmail.org/docs/deployment/monitoring#tracing
 */
export function tracingEndpoint(env: Record<string, string | undefined> = process.env): string | null {
  if ((env.OTEL_SDK_DISABLED ?? '').trim().toLowerCase() === 'true') return null;
  const exporters = (env.OTEL_TRACES_EXPORTER ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (exporters.length > 0 && !exporters.includes('otlp')) return null;
  const endpoint = (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim();
  return endpoint || null;
}

export function tracingConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return tracingEndpoint(env) !== null;
}

const ACTIVE = Symbol.for('bulwark.tracing.active');

/** Set by lib/tracing/start.ts once the SDK is registered. */
export function markTracingActive(): void {
  (globalThis as typeof globalThis & { [ACTIVE]?: boolean })[ACTIVE] = true;
}

export function isTracingActive(): boolean {
  return (globalThis as typeof globalThis & { [ACTIVE]?: boolean })[ACTIVE] === true;
}
