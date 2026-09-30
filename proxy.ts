import { NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { localeFromAcceptLanguage } from "./i18n/locale-matcher";
import { isSameOriginRequest } from "./lib/security/same-origin";
import { getEnabledPluginFrameOrigins } from "./lib/admin/csp-frame-origins";
import {
  inlineAppFrameOrigins,
  parseAppFrameOrigins,
  pickAppFrameOriginsCookie,
} from "./lib/security/app-frame-origins";
import { configManager } from "./lib/admin/config-manager";
import { detectSetupState } from "./lib/setup/state";

const intlMiddleware = createIntlMiddleware(routing);

/**
 * next-intl uses best-fit locale matching, which can rank `zh` ahead of
 * `zh-TW` for regional Traditional Chinese tags such as `zh-HK`. Collapse a
 * Chinese Accept-Language list to the exact locale selected by Bulwark's
 * script/region-aware matcher before handing the request to next-intl. URL
 * prefixes and the NEXT_LOCALE cookie still keep their higher precedence.
 */
function withMatchedChineseAcceptLanguage(request: NextRequest): NextRequest {
  const localeCookie = routing.localeCookie;
  const localeCookieName =
    localeCookie === false
      ? null
      : typeof localeCookie === "object" && localeCookie.name
        ? localeCookie.name
        : "NEXT_LOCALE";
  const cookieLocale = localeCookieName ? request.cookies.get(localeCookieName)?.value : undefined;
  if (cookieLocale && (routing.locales as readonly string[]).includes(cookieLocale)) return request;

  const acceptLanguage = request.headers.get("accept-language");
  const locale = localeFromAcceptLanguage(acceptLanguage, routing.locales);
  if (locale !== "zh" && locale !== "zh-TW") return request;
  if (acceptLanguage === locale) return request; // nothing to collapse, keep the original request

  const headers = new Headers(request.headers);
  headers.set("accept-language", locale);
  // A cloned NextRequest re-parses its URL, so `nextConfig` has to be handed
  // over as well: without it the base path stays glued to nextUrl.pathname and
  // next-intl rewrites a sub-path install to /zh-TW/<basePath>/... (a 404)
  // instead of /<basePath>/zh-TW/....
  const basePath = request.nextUrl.basePath;
  return new NextRequest(request, { headers, nextConfig: basePath ? { basePath } : undefined });
}

// Next 16's Proxy always runs on Node.js runtime and route-segment config
// (e.g. `export const config = { matcher }`) is no longer allowed in the
// proxy file. We replicate the previous matcher inline by short-circuiting
// requests for API routes, Next internals and static assets.
const PROXY_SKIP_PATTERN = /^\/(?:api|_next)(?:\/|$)/;

// What Next serves from public/: a single dotted segment at the root
// (/sw.js, /favicon.ico, /manifest.webmanifest) and the branding/,
// notification/ and demo/ asset folders. The upstream matcher treated EVERY path whose
// last segment has a dot as a static file, but the [[...segments]] catch-alls
// under /<locale>/mail, /calendar, /contacts and /files make
// /en/mail/folder/inbox/statement.pdf a real signed-in page, and it rendered
// without a CSP or any other security header (GHSA-xvjh-v9c6-qcvc). Only what
// is genuinely static may skip locale routing and the headers.
const STATIC_ASSET_PATTERN = /^\/[^/]+\.[^/]+$|^\/(?:branding|notification|demo)\//;

export function isStaticAssetPath(pathname: string): boolean {
  return STATIC_ASSET_PATTERN.test(pathname);
}

/**
 * Hand the route every request header the client sent, plus `extra`.
 *
 * Next forwards ONLY the request headers listed in
 * `x-middleware-override-headers` and deletes every other one. A bare
 * NextResponse.next() carries no such list, so listing just x-nonce/x-pathname
 * on it (as this proxy used to) stripped RSC, Next-Router-State-Tree,
 * Next-Url, Cookie, Accept-Language, ... from every page request that skips
 * the intl middleware: all locale-prefixed paths - i.e. every page of a
 * NEXT_PUBLIC_LOCALE_PREFIX=always (Docker) build - plus /admin, /protocol,
 * /setup, /connector and the plugin sandbox. Since Next 16.3 the server recomputes the
 * `_rsc` cache-busting hash from those router headers
 * (experimental.validateRSCRequestHeaders, on by default) and answers a
 * mismatch with a 307 to the "expected" URL; the client re-requests, the
 * headers are stripped again, and every navigation and link prefetch spun
 * through a 307/200 loop for about a second - the old view stayed on screen
 * for that long on each top-level switch and after login (#919).
 *
 * When the response already lists headers (the intl middleware's rewrite
 * passes the full set), only `extra` is appended.
 */
function forwardRequestHeaders(
  response: NextResponse,
  request: NextRequest,
  extra: Record<string, string>,
): NextResponse {
  // A redirect renders no route, so there is nothing to forward to.
  if (response.headers.has("location")) return response;
  const listed = new Set(
    (response.headers.get("x-middleware-override-headers") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  if (listed.size === 0) {
    for (const [name, value] of request.headers) {
      listed.add(name);
      response.headers.set(`x-middleware-request-${name}`, value);
    }
  }
  for (const [name, value] of Object.entries(extra)) {
    listed.add(name);
    response.headers.set(`x-middleware-request-${name}`, value);
  }
  response.headers.set("x-middleware-override-headers", Array.from(listed).join(","));
  return response;
}

/**
 * The path Next routes on. `nextUrl.pathname` keeps percent-escapes, but the
 * route matcher decodes them, so `/api/%61uth/session` reaches the
 * `/api/auth/session` handler. Security decisions must use the decoded form
 * or an escaped spelling walks around them.
 */
export function routePathOf(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Paths under /api/ that must accept requests without a same-origin browser
 * context: the office editor's WOPI host calls the file endpoints
 * server-to-server with a token of its own, not the session cookie.
 */
function isOriginGateExempt(routePath: string): boolean {
  return routePath.startsWith("/api/wopi/files/");
}

function isSetupPath(pathname: string): boolean {
  return (
    pathname === "/setup" ||
    pathname.startsWith("/setup/") ||
    pathname.startsWith("/api/setup")
  );
}

export async function proxy(request: NextRequest) {
  // Resolve setup state before deciding what to skip. The first call after
  // boot triggers the config load; subsequent calls are in-memory.
  await configManager.ensureLoaded();
  const setupState = detectSetupState();
  // Raw form for what is echoed back (x-pathname); decoded form for every
  // decision about the request.
  const rawPathname = request.nextUrl.pathname;
  const pathname = routePathOf(rawPathname);

  if (setupState === "bootstrap") {
    // Wizard active. Redirect HTML pages to /setup; let asset/internal
    // requests through so the wizard UI can render. Block non-setup APIs
    // with a 503 so cached SPA code doesn't silently call them.
    const allowed =
      isSetupPath(pathname) ||
      pathname === "/api/health" ||
      pathname.startsWith("/_next/") ||
      pathname.startsWith("/branding/") ||
      // Public read endpoint - serves wizard-uploaded branding assets so
      // image previews work during the wizard. No auth on the GET route.
      pathname.startsWith("/api/admin/branding/") ||
      isStaticAssetPath(pathname);

    if (!allowed) {
      if (pathname.startsWith("/api/")) {
        return new NextResponse(
          JSON.stringify({ error: "setup_required", message: "Initial setup has not completed." }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = "/setup";
      url.search = request.nextUrl.search;
      return NextResponse.redirect(url);
    }
  } else if (isSetupPath(pathname)) {
    // Configured / env-managed: wizard is no longer reachable.
    //  - HTML /setup pages → redirect to admin login so users who reload
    //    the URL after setup don't see a dead "Not Found" page.
    //  - /api/setup/* → 404 (no reason to expose these endpoints).
    if (pathname.startsWith("/api/setup")) {
      return new NextResponse("Not Found", { status: 404 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Outer CSRF gate for every API route (GHSA-qvr9-m8cq-7wvg,
  // GHSA-9mvj-98f5-9q6g). The identity cookies are SameSite=Lax, which a
  // same-site sibling origin still receives, so any route that acts with
  // them needs an origin check. The state-changing handlers check this
  // themselves as well; this layer covers any route added later.
  // GET/HEAD/OPTIONS pass through untouched.
  if (pathname.startsWith("/api/") && !isOriginGateExempt(pathname) && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }

  if (PROXY_SKIP_PATTERN.test(pathname) || isStaticAssetPath(pathname)) {
    // No page CSP here, but what comes back can still be a document: the
    // not-found shell for a missing /foo.html or an unknown /api route. It
    // must not be framed or sniffed into another type. API routes set their
    // own CSP where they need one, so only non-API paths get frame-ancestors.
    const skipped = NextResponse.next();
    skipped.headers.set("X-Content-Type-Options", "nosniff");
    skipped.headers.set("X-Frame-Options", "DENY");
    if (!pathname.startsWith("/api/")) {
      skipped.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    }
    return skipped;
  }

  const nonce = crypto.randomUUID();
  const isDev = process.env.NODE_ENV === "development";
  // The plugin-sandbox iframe document needs `'unsafe-eval'` to run plugin
  // bundles via `new Function`. The untrusted route is null-origin
  // (sandbox="allow-scripts"); the privileged route is same-origin
  // (allow-same-origin) so a vetted plugin gets real WebCrypto + IndexedDB.
  // Both get the SAME CSP relaxations (unsafe-eval, frame-ancestors 'self');
  // the privileged route's extra power comes from the iframe sandbox flag the
  // host sets, gated by signature + admin approval, NOT from a wider CSP.
  const isSandboxPath =
    pathname === "/plugin-sandbox" ||
    pathname.startsWith("/plugin-sandbox/") ||
    pathname === "/plugin-sandbox-privileged" ||
    pathname.startsWith("/plugin-sandbox-privileged/");

  // The sandbox routes are only ever loaded as iframes by the host bridge.
  // Refuse them as a top-level document (window.open() from another site, a
  // typed URL): the browser sets `Sec-Fetch-Dest` and page script cannot
  // forge it; browsers without it fall through to the runtime's own host gate.
  // They also disappear entirely while the plugin feature is off, so a stock
  // install never serves a document carrying 'unsafe-eval'
  // (GHSA-96cx-gx36-3g79). Other destinations pass - `iframe` for the bridge,
  // `empty` for the router's own RSC refetches - and cross-site framing is
  // already blocked by the `frame-ancestors 'self'` below.
  if (isSandboxPath) {
    const pluginsEnabled = configManager.getPolicy().features?.pluginsEnabled === true;
    if (!pluginsEnabled || request.headers.get("sec-fetch-dest") === "document") {
      return new NextResponse("The plugin sandbox is only served inside the webmail.", {
        status: 403,
        headers: { "content-type": "text/plain" },
      });
    }
  }

  const scriptSrc = isSandboxPath
    ? `'self' 'nonce-${nonce}' 'unsafe-eval'`
    : isDev
    ? `'self' 'nonce-${nonce}' 'unsafe-eval'`
    : `'self' 'nonce-${nonce}'`;

  const connectSrc = isDev ? `'self' http: https: ws: wss:` : `'self' https:`;

  // The admin dashboard and the setup wizard are never framed. The embedding
  // allowance is for the mail UI a portal wraps; a framed admin page is a
  // clickjacking target with nothing to gain from being embedded.
  const isAdminOrSetupPath = /^\/(?:admin|setup)(?:\/|$)/.test(pathname);
  const frameAncestors = isSandboxPath
    ? `'self'`
    : isAdminOrSetupPath
    ? "'none'"
    : process.env.ALLOWED_FRAME_ANCESTORS?.trim() || "'none'";

  // Plugins may declare iframe origins they need (e.g. for embedded video).
  // Each origin is validated at install time and re-validated here.
  const pluginFrameOrigins = await getEnabledPluginFrameOrigins();

  // Sidebar Apps set to open "inline" are a per-user setting the proxy can't
  // read, so the client mirrors their origins into a cookie (#787). Ignored
  // when the admin has turned the feature off, so a stale cookie can't keep
  // widening the CSP after the fact.
  const policy = configManager.getPolicy();
  const sidebarAppsEnabled = policy.features?.sidebarAppsEnabled !== false;
  const appFrameOrigins = sidebarAppsEnabled
    ? parseAppFrameOrigins(pickAppFrameOriginsCookie(
        (name) => request.cookies.get(name)?.value,
        request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https",
      ))
    : [];

  // Apps the operator pins for everyone (#931) are known server-side, so their
  // origins go straight into the header - no cookie handshake, and no reload
  // the first time a user opens one. They survive the gate above, which only
  // governs the apps users add themselves.
  const managedAppFrameOrigins = inlineAppFrameOrigins(policy.defaultSidebarApps);

  // WOPI document editor (#425): the editor is launched by POSTing the access
  // token into an iframe on its origin, so that origin must be allowed in both
  // frame-src AND form-action (which is otherwise 'self').
  let wopiOrigin = "";
  try {
    const wopiClientUrl = configManager.get<string>("wopiClientUrl", "").trim();
    if (wopiClientUrl) wopiOrigin = new URL(wopiClientUrl).origin;
  } catch {
    // Invalid admin-supplied URL - leave the CSP unchanged.
  }

  const frameOrigins: string[] = [];
  const seenFrameOrigins = new Set<string>();
  for (const origin of [...pluginFrameOrigins, ...managedAppFrameOrigins, ...appFrameOrigins, ...(wopiOrigin ? [wopiOrigin] : [])]) {
    const key = origin.toLowerCase();
    if (seenFrameOrigins.has(key)) continue;
    seenFrameOrigins.add(key);
    frameOrigins.push(origin);
  }

  const frameSrc =
    frameOrigins.length > 0
      ? `frame-src 'self' blob: ${frameOrigins.join(" ")}`
      : `frame-src 'self' blob:`;

  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' https: data:`,
    `connect-src ${connectSrc}`,
    frameSrc,
    `object-src 'self' blob:`,
    `base-uri 'self'`,
    `form-action 'self'${wopiOrigin ? ` ${wopiOrigin}` : ""}`,
    `frame-ancestors ${frameAncestors}`,
    `media-src 'self' blob:`,
  ].join("; ");

  // Skip intl middleware for routes outside the localized app tree.
  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/');
  const isProtocolRoute = pathname === '/protocol' || pathname.startsWith('/protocol/');
  const isSetupRoute = pathname === '/setup' || pathname.startsWith('/setup/');
  // Connector links (/connector/<target>) are published in docs and READMEs
  // and must not carry a locale. Letting next-intl rewrite them to
  // /en/connector/... 404s, which breaks every link already in the wild.
  const isConnectorRoute = pathname === '/connector' || pathname.startsWith('/connector/');
  // The plugin sandbox lives in its own root layout under app/(sandbox)/ and
  // is not part of the localized tree. Letting next-intl rewrite the path to
  // /en/plugin-sandbox 404s, which kills the iframe and disables every plugin.
  const isSandboxRoute = isSandboxPath;

  // When localePrefix is 'always', paths that already have a locale prefix
  // (e.g. /en/settings) should not be re-processed by the intl middleware -
  // doing so can trigger rewrite loops when combined with a proxy basePath.
  const locales = routing.locales as readonly string[];
  const hasLocalePrefix = locales.some(
    (l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`)
  );

  let intlResponse: ReturnType<typeof intlMiddleware> | null = null;
  if (
    !isAdminRoute &&
    !isProtocolRoute &&
    !isSetupRoute &&
    !isSandboxRoute &&
    !isConnectorRoute &&
    !hasLocalePrefix
  ) {
    try {
      intlResponse = intlMiddleware(withMatchedChineseAcceptLanguage(request));
    } catch (error) {
      console.error('Locale middleware error:', error);
    }
  }
  const response = intlResponse ?? NextResponse.next();

  // Expose the nonce AND the request pathname to server components as request
  // headers. The root (main)/layout renders <html> ABOVE the [locale] segment,
  // so getLocale() can't resolve the active locale there and falls back to the
  // default - emitting <html lang="en"> on e.g. /de pages, which makes browsers
  // offer to "translate this page". The layout reads x-pathname to recover it.
  forwardRequestHeaders(response, request, { "x-nonce": nonce, "x-pathname": rawPathname });

  response.headers.set("X-Content-Type-Options", "nosniff");

  // X-Frame-Options only supports DENY/SAMEORIGIN. When frame-ancestors
  // specifies explicit origins, we rely solely on the CSP header.
  if (frameAncestors === "'none'") {
    response.headers.set("X-Frame-Options", "DENY");
  }

  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-XSS-Protection", "0");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );
  response.headers.set("Content-Security-Policy", csp);

  return response;
}
