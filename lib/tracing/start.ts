import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import type { Context } from '@opentelemetry/api';
import { markTracingActive } from './config';
import { scrubAttributes, scrubSpanName, type Attributes } from './scrub';

/**
 * OpenTelemetry tracing, loaded only by a dynamic import from
 * instrumentation.ts when an OTLP endpoint is configured (./config.ts).
 * Everything else comes from the standard OTEL_* variables, which the OTLP
 * exporter and the env resource detector read themselves.
 *
 * Next's own spans (requests, rendering, route handlers) and Bulwark's spans
 * for the calls it makes (lib/metrics/upstream.ts) go through the same
 * provider; a processor scrubs every span before export (./scrub.ts).
 *
 * https://bulwarkmail.org/docs/deployment/monitoring#tracing
 */

/** Scrubs a span's name and attributes, then hands it on. */
export class ScrubbingSpanProcessor implements SpanProcessor {
  constructor(private readonly next: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    scrubAttributes(span.attributes as Attributes);
    const named = span as unknown as { name: string };
    named.name = scrubSpanName(span.name);
    for (const event of span.events) if (event.attributes) scrubAttributes(event.attributes as Attributes);
    this.next.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

export function createProvider(exporter: SpanExporter, batch = true): NodeTracerProvider {
  const resource = resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME?.trim() || 'bulwark-webmail',
    'service.version': process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
  }).merge(detectResources({ detectors: [envDetector] }));
  const inner: SpanProcessor = batch ? new BatchSpanProcessor(exporter) : new SimpleSpanProcessor(exporter);
  return new NodeTracerProvider({ resource, spanProcessors: [new ScrubbingSpanProcessor(inner)] });
}

export function startTracing(): void {
  const provider = createProvider(new OTLPTraceExporter());
  provider.register({ propagator: new W3CTraceContextPropagator() });
  markTracingActive();
}
