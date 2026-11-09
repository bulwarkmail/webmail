import { observeUpstreamResult, type UpstreamTarget } from './index';
import { isTracingActive } from '@/lib/tracing/config';

/** Headers that carry the trace context to the service called (`traceparent`). */
export type TraceHeaders = Record<string, string>;

/**
 * Run one request this server makes to another service, under a fixed
 * target name:
 *
 * - metrics (when /api/metrics is on): duration and outcome. An answer
 *   below 500 counts as ok (a 401 from Stalwart is an answer); a 5xx or a
 *   thrown error as error.
 * - tracing (when OTEL_* is set): a client span named after the target,
 *   with no URL, host or user in it, and the W3C trace context handed to
 *   `run` as headers, so the callee's spans join the trace.
 *
 * Costs nothing while both are off.
 */
export async function observeUpstream<T extends { status: number }>(
  target: UpstreamTarget,
  run: (traceHeaders: TraceHeaders) => Promise<T>,
): Promise<T> {
  if (isTracingActive()) return traced(target, run);
  return measured(target, () => run({}));
}

async function measured<T extends { status: number }>(target: UpstreamTarget, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const response = await run();
    observeUpstreamResult(target, response.status < 500, (performance.now() - start) / 1000);
    return response;
  } catch (error) {
    observeUpstreamResult(target, false, (performance.now() - start) / 1000);
    throw error;
  }
}

async function traced<T extends { status: number }>(target: UpstreamTarget, run: (traceHeaders: TraceHeaders) => Promise<T>): Promise<T> {
  const api = await import('@opentelemetry/api');
  const tracer = api.trace.getTracer('bulwark-webmail');
  return tracer.startActiveSpan(`upstream ${target}`, {
    kind: api.SpanKind.CLIENT,
    attributes: { 'bulwark.upstream.target': target },
  }, async (span) => {
    const headers: TraceHeaders = {};
    api.propagation.inject(api.context.active(), headers);
    try {
      const response = await measured(target, () => run(headers));
      span.setAttribute('http.response.status_code', response.status);
      if (response.status >= 500) span.setStatus({ code: api.SpanStatusCode.ERROR });
      return response;
    } catch (error) {
      // The error's name only: messages can name hosts or paths.
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: error instanceof Error ? error.name : 'Error' });
      throw error;
    } finally {
      span.end();
    }
  });
}
