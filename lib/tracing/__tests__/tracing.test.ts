// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, get: (_key: string, fallback: unknown) => fallback },
}));

import { createProvider } from '../start';
import { markTracingActive } from '../config';
import { scrubAttributes, scrubSpanName } from '../scrub';
import { observeUpstream } from '@/lib/metrics/upstream';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';

const exporter = new InMemorySpanExporter();
const provider = createProvider(exporter, false);
const ADDRESS = 'ceo.private@acme-corp.example';

beforeAll(() => {
  provider.register({ propagator: new W3CTraceContextPropagator() });
  markTracingActive();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});
beforeEach(() => exporter.reset());

describe('spans for upstream calls', () => {
  it('are named after the target and carry no URL, host or user', async () => {
    await observeUpstream('wopi', async () => new Response(null, { status: 200 }));
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('upstream wopi');
    expect(span.attributes).toEqual({ 'bulwark.upstream.target': 'wopi', 'http.response.status_code': 200 });
  });

  it('hand the trace context to the callee', async () => {
    let seen: Record<string, string> = {};
    await observeUpstream('stalwart', async (headers) => { seen = headers; return new Response(null, { status: 401 }); });
    const [span] = exporter.getFinishedSpans();
    expect(seen.traceparent).toMatch(new RegExp(`^00-${span.spanContext().traceId}-${span.spanContext().spanId}-01$`));
  });

  it('reach Stalwart as a traceparent header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await fetchJmapServer('https://mail.example.org/jmap/session', { headers: { Accept: 'application/json' } }, true);
      const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
      expect(headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(headers.get('accept')).toBe('application/json');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reach Stalwart from the sign-in check too', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ apiUrl: 'https://mail.example.org/jmap/', username: 'u@example.org' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await verifyJmapAuth('https://mail.example.org', 'Basic dTpw', { trusted: true }).catch(() => undefined);
      const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
      expect(String(fetchSpy.mock.calls[0][0])).toBe('https://mail.example.org/.well-known/jmap');
      expect(headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(headers.get('authorization')).toBe('Basic dTpw');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('mark 5xx and thrown errors as errors, without the error message', async () => {
    await expect(observeUpstream('translate', async () => { throw new Error(`refused for ${ADDRESS}`); })).rejects.toThrow();
    const [span] = exporter.getFinishedSpans();
    expect(span.status).toEqual({ code: 2, message: 'Error' });
  });
});

describe('every exported span', () => {
  it('is scrubbed before export', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('fetch GET https://mail.example.org/jmap/download/a/b/term-sheet.pdf?accept=x');
    span.setAttributes({
      'url.full': 'https://mail.example.org/jmap/download/a/b/term-sheet.pdf?accept=x',
      'http.target': '/en/mail/folder/Acquisition%20Talks/Mabc?q=merger',
      'url.query': 'q=merger',
      'http.user_agent': 'Mozilla/5.0',
      'client.address': '203.0.113.7',
      'enduser.id': ADDRESS,
      'next.route': '/[locale]/mail/[[...segments]]',
      'custom.note': `sent by ${ADDRESS} with Bearer abc.def`,
    });
    span.end();
    const [exported] = exporter.getFinishedSpans();
    expect(exported.name).toBe('fetch GET https://mail.example.org');
    expect(exported.attributes).toEqual({
      'url.full': 'https://mail.example.org',
      'http.target': '/mail/…',
      'next.route': '/[locale]/mail/[[...segments]]',
      'custom.note': 'sent by [email] with Bearer [token]',
    });
  });
});

describe('span names', () => {
  it('keep route patterns and reduce raw paths', () => {
    expect(scrubSpanName('GET /api/admin/plugins/[id]')).toBe('GET /api/admin/plugins/[id]');
    expect(scrubSpanName('GET /de/contacts/Mustermann')).toBe('GET /contacts/…');
    const attrs: Record<string, string> = { 'url.path': '/api/wopi/files/abc' };
    scrubAttributes(attrs);
    expect(attrs['url.path']).toBe('/api/wopi/…');
  });
});
