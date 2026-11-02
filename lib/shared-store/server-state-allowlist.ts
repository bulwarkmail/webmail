/**
 * Module-level state the server is allowed to keep outside the shared store
 * (#1066), checked by lib/shared-store/__tests__/server-state-guard.test.ts.
 *
 * A new `let`, `new Map()` and the like in anything a route, the proxy or
 * instrumentation loads fails that test until it either goes through the
 * shared store (lib/shared-store) or is listed here with its class:
 *
 * - cache: a copy of something authoritative elsewhere; replicas may
 *   disagree for at most the time given in the reason.
 * - per-process: belongs to this process by nature (connection pools, log
 *   flags, the dev mock server, browser-only modules the server imports).
 * - store-backed: looks like local state, but in shared mode it lives in
 *   the shared store (the reason says how).
 */

export type StateClass = 'cache' | 'per-process' | 'store-backed';

export interface AllowedState {
  /** Repo-relative path and variable name, `file#name`. */
  site: string;
  class: StateClass;
  why: string;
}

export const SERVER_STATE_ALLOWLIST: AllowedState[] = [
  { site: 'app/api/admin/auth/route.ts#adminCheckCache', class: 'cache', why: 'Stalwart superuser probe, 60 s per entry, capped at 1000' },
  { site: 'app/api/dev-jmap/[...path]/route.ts#scheduledSubmissions', class: 'per-process', why: 'dev mock JMAP server, removed from the Docker build' },
  { site: 'app/api/dev-jmap/[...path]/route.ts#emailCreationIds', class: 'per-process', why: 'dev mock JMAP server' },
  { site: 'app/api/dev-jmap/[...path]/route.ts#pushSubscriptions', class: 'per-process', why: 'dev mock JMAP server' },
  { site: 'app/api/dev-jmap/[...path]/route.ts#stateCounter', class: 'per-process', why: 'dev mock JMAP server' },
  { site: 'app/api/dev-jmap/[...path]/route.ts#samplePhotos', class: 'per-process', why: 'dev mock JMAP server' },
  { site: 'app/api/dev-jmap/[...path]/route.ts#uploadedBlobs', class: 'per-process', why: 'dev mock JMAP server' },
  { site: 'app/api/favicon/route.ts#upstreamInFlight', class: 'per-process', why: 'caps this process\'s concurrent upstream fetches' },
  { site: 'app/api/favicon/route.ts#cache', class: 'cache', why: 'sender icons from a public service, 14 days' },
  { site: 'app/api/favicon/route.ts#negativeCache', class: 'cache', why: 'sender icons that failed, 1 day' },
  { site: 'app/api/ready/route.ts#last', class: 'cache', why: 'the last store ping, 1 s, so probes can\'t flood the store' },
  { site: 'lib/tracing/config.ts#globalThis:ACTIVE', class: 'per-process', why: 'whether this process registered the OpenTelemetry SDK at startup' },
  { site: 'lib/error-reporting/debug-ids.ts#cache', class: 'per-process', why: 'debug ids of the bundle files this process loaded, read from globalThis' },
  { site: 'lib/admin/directory-keys.ts#keyringCache', class: 'cache', why: 'extension directory keys, 10 min; the anti-rollback record is in the store' },
  { site: 'lib/admin/paths.ts#cachedReadOnly', class: 'per-process', why: 'parsed ADMIN_CONFIG_READONLY env' },
  { site: 'lib/admin/plugin-approvals.ts#maxPackageBytes', class: 'per-process', why: 'a limit tests can lower' },
  { site: 'lib/auth/bearer-identity.ts#cache', class: 'cache', why: 'bearer token identities, 60 s valid / 30 s invalid, capped at 1000' },
  { site: 'lib/auth/bearer-identity.ts#refusedBudget', class: 'store-backed', why: 'createFailureBudget: shared counters in shared mode' },
  { site: 'lib/auth/client-address.ts#NOT_A_CLIENT', class: 'per-process', why: 'a constant address list built once' },
  { site: 'lib/auth/handoff-store.ts#createBudget', class: 'store-backed', why: 'createFailureBudget: shared counters in shared mode' },
  { site: 'lib/auth/handoff-store.ts#redeemBudget', class: 'store-backed', why: 'createFailureBudget: shared counters in shared mode' },
  { site: 'lib/auth/session-age.ts#missingSecretLogged', class: 'per-process', why: 'log once per process' },
  { site: 'lib/auth/session-secret.ts#globalThis:SHARED_CACHE', class: 'store-backed', why: 'the generated secret read from the store at boot; it never changes' },
  { site: 'lib/auth/stalwart-password-login.ts#defaultClients', class: 'cache', why: 'Stalwart\'s public client id, 10 min; registration is deterministic' },
  { site: 'lib/auth/verify-budget.ts#verifyBudget', class: 'store-backed', why: 'createFailureBudget: shared counters in shared mode' },
  { site: 'lib/auth/verify-budget.ts#loginBudget', class: 'store-backed', why: 'createFailureBudget: shared counters in shared mode' },
  { site: 'lib/bimi/lookup.ts#shared', class: 'cache', why: 'BIMI records and logos, 24 h / 6 h / 10 min' },
  { site: 'lib/bimi/roots.ts#parsed', class: 'per-process', why: 'pinned root certificates parsed once' },
  { site: 'lib/demo/demo-utils.ts#demoIdCounter', class: 'per-process', why: 'demo mode ids, no real data' },
  { site: 'lib/oauth/discovery.ts#metadataCache', class: 'cache', why: 'OAuth/OIDC discovery documents, 10 min' },
  { site: 'lib/oauth/discovery.ts#negativeCache', class: 'cache', why: 'failed discovery, 15 s back-off' },
  { site: 'lib/plugin-sandbox/sandbox-document.ts#cached', class: 'per-process', why: 'this build\'s sandbox asset manifest' },
  { site: 'lib/plugin-secrets/proxy.ts#windows', class: 'per-process', why: 'plugin proxy rate limit, documented as per replica (300 a minute each)' },
  { site: 'lib/plugin-secrets/proxy.ts#running', class: 'per-process', why: 'plugin proxy concurrency per replica' },
  { site: 'lib/security/url-guard.ts#publicDispatcher', class: 'per-process', why: 'connection pool' },
  { site: 'lib/security/url-guard.ts#proxiedDispatchers', class: 'per-process', why: 'connection pools per proxy' },
  { site: 'lib/security/url-guard.ts#privateHostDispatchers', class: 'per-process', why: 'connection pools per admin-entered intranet feed host' },
  { site: 'lib/telemetry/payload.ts#processStartedAt', class: 'per-process', why: 'this process\'s uptime' },
  { site: 'lib/theme-color-meta.ts#enabled', class: 'per-process', why: 'browser-side module reached through a shared import' },
  { site: 'lib/theme-color-meta.ts#scheduled', class: 'per-process', why: 'browser-side module reached through a shared import' },
  { site: 'lib/third-party-mode.ts#state', class: 'per-process', why: 'browser-side state; the server only uses its parse helpers' },
  { site: 'lib/third-party-mode.ts#listeners', class: 'per-process', why: 'browser-side state; the server only uses its parse helpers' },
  { site: 'lib/timezone.ts#browserTimeZone', class: 'per-process', why: 'browser-side value' },
  { site: 'lib/timezone.ts#validityCache', class: 'cache', why: 'time zone name checks, immutable' },
  { site: 'lib/timezone.ts#canonicalCache', class: 'cache', why: 'canonical time zone names, immutable' },
  { site: 'lib/timezone.ts#wallClockFormatterCache', class: 'cache', why: 'Intl formatters' },
  { site: 'lib/utils.ts#dateFormatters', class: 'cache', why: 'Intl formatters' },
  { site: 'lib/wopi/files.ts#blobUrlCache', class: 'cache', why: 'JMAP blob URL templates per server, 5 min' },
];
