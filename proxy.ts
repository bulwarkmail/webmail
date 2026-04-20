import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

const intlMiddleware = createIntlMiddleware(routing);

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID();
  const isDev = process.env.NODE_ENV === "development";

  const scriptSrc = isDev
    ? `'self' 'nonce-${nonce}' 'unsafe-eval' blob:`
    : `'self' 'nonce-${nonce}' blob:`;

  const connectSrc = isDev ? `'self' https: ws: wss:` : `'self' https:`;

  const frameAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim() || "'none'";

  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self'`,
    `connect-src ${connectSrc}`,
    `frame-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors ${frameAncestors}`,
    `media-src 'self' blob:`,
  ].join("; ");

  // Skip intl middleware for /admin routes - they have their own layout
  const pathname = request.nextUrl.pathname;
  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/');

  // When localePrefix is 'always', paths that already have a locale prefix
  // (e.g. /en/settings) should not be re-processed by the intl middleware -
  // doing so can trigger rewrite loops when combined with a proxy basePath.
  const locales = routing.locales as readonly string[];
  const hasLocalePrefix = locales.some(
    (l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`)
  );

  let intlResponse: ReturnType<typeof intlMiddleware> | null = null;
  if (!isAdminRoute && !hasLocalePrefix) {
    try {
      intlResponse = intlMiddleware(request);
    } catch (error) {
      console.error('Locale middleware error:', error);
    }
  }
  const response = intlResponse ?? NextResponse.next();

  const existing = response.headers.get("x-middleware-override-headers");
  response.headers.set(
    "x-middleware-override-headers",
    existing ? `${existing},x-nonce` : "x-nonce"
  );
  response.headers.set("x-middleware-request-x-nonce", nonce);

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

export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
