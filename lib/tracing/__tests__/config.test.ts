// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tracingConfigured, tracingEndpoint } from '../config';
import { listReachableHosts } from '@/lib/admin/reachable-hosts';

const started = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/tracing/start', () => ({ startTracing: () => { started.count++; } }));
vi.mock('@/instrumentation.node', () => ({}));

afterEach(() => {
  vi.unstubAllEnvs();
  started.count = 0;
});

describe('tracing configuration', () => {
  it('needs an OTLP endpoint from the standard variables', () => {
    expect(tracingConfigured({})).toBe(false);
    expect(tracingEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe('http://collector:4318');
    expect(tracingEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:4318', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://b:4318/v1/traces' })).toBe('http://b:4318/v1/traces');
  });

  it('honours OTEL_SDK_DISABLED and OTEL_TRACES_EXPORTER=none', () => {
    expect(tracingConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SDK_DISABLED: 'true' })).toBe(false);
    expect(tracingConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_TRACES_EXPORTER: 'none' })).toBe(false);
    expect(tracingConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_TRACES_EXPORTER: 'otlp' })).toBe(true);
  });

  it('loads the SDK at startup only when configured', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('@/instrumentation');
    await register();
    expect(started.count).toBe(0);
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector.example.org:4318');
    await register();
    expect(started.count).toBe(1);
  });

  it('lists the OTLP endpoint as a host the admin set, only when set', () => {
    const base = { get: () => undefined, policy: { pushRelays: [], pushRelayUrl: '', defaultSidebarApps: [], features: { sidebarAppsEnabled: false, calendarEnabled: false } }, buildRelayUrl: '' };
    expect(listReachableHosts({ ...base, env: {} }).filter((h) => h.kind === 'Tracing (OTLP)')).toEqual([]);
    expect(listReachableHosts({ ...base, env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.org:4318' } }).filter((h) => h.kind === 'Tracing (OTLP)'))
      .toEqual([{ kind: 'Tracing (OTLP)', host: 'otel.example.org:4318', origin: 'https://otel.example.org:4318', setIn: 'OTEL_EXPORTER_OTLP_ENDPOINT', side: 'server' }]);
  });
});
