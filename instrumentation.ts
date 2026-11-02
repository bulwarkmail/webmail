import type { Instrumentation } from "next";
import { tracingConfigured } from "./lib/tracing/config";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // OpenTelemetry, only with an OTLP endpoint in the standard OTEL_*
    // variables; otherwise the SDK is never loaded. First, so Next's own
    // spans from the first request on go to it.
    // https://bulwarkmail.org/docs/deployment/monitoring#tracing
    if (tracingConfigured()) {
      const { startTracing } = await import("./lib/tracing/start");
      startTracing();
    }
    await import("./instrumentation.node");
  }
}

/**
 * Errors Next caught while rendering a page or running a route handler,
 * server action or the proxy. Counted, and sent to the error tracker when
 * one is configured (lib/error-reporting/server.ts); nothing happens while
 * error reporting is off. https://bulwarkmail.org/docs/deployment/monitoring
 */
export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureRequestError } = await import("./lib/error-reporting/server");
  await captureRequestError(error, context.routePath);
};
