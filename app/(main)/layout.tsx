import type { Metadata, Viewport } from "next";
import { getLocaleDirection } from "@/i18n/direction";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { FaviconBadge } from "@/components/favicon-badge";
import { ThemeColorSync } from "@/components/theme-color-sync";
import { configManager } from "@/lib/admin/config-manager";
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
  type BrandingOverrideKey,
} from "@/lib/admin/domain-branding";
import { withBasePath } from "@/lib/browser-navigation";
import { locales } from "@/i18n/routing";
import "../globals.css";

// This layout renders <html> and sits ABOVE the [locale] segment, so
// next-intl's getLocale() returns the default locale here - emitting
// <html lang="en"> on e.g. /de pages, which makes browsers offer to
// "translate this page". Recover the active locale from the request pathname
// (exposed by proxy.ts as x-pathname), falling back to getLocale() (cookie /
// Accept-Language) when the path carries no locale segment.
async function resolveRequestLocale(): Promise<string> {
  const pathname = (await headers()).get("x-pathname") || "";
  const seg = pathname.split("/").find((s) => (locales as readonly string[]).includes(s));
  return seg ?? (await getLocale());
}

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Resolve a branding value for the requesting host: per-domain override first,
// then the global admin/env/default value (same precedence as app/manifest.ts).
async function brandedValue(key: BrandingOverrideKey, fallback: string): Promise<string> {
  const host = pickRequestHost(await headers());
  const override = matchDomainBranding(
    host,
    parseDomainBranding(configManager.get<unknown>("domainBranding", [])),
  )[key];
  if (typeof override === "string" && override.length > 0) return override;
  return configManager.get<string>(key, fallback);
}

/**
 * Whether an admin explicitly set a PWA theme colour (per-domain override, or
 * an admin/env value rather than the built-in default). When they have, it wins
 * outright; when they haven't, <ThemeColorSync /> tracks the active theme.
 */
async function hasExplicitThemeColor(): Promise<boolean> {
  const host = pickRequestHost(await headers());
  const override = matchDomainBranding(
    host,
    parseDomainBranding(configManager.get<unknown>("domainBranding", [])),
  ).pwaThemeColor;
  if (typeof override === "string" && override.length > 0) return true;
  return configManager.getAllWithSources().pwaThemeColor?.source !== "default";
}

/**
 * Absolute origin this request came in on, used as `metadataBase` so Next.js
 * can turn the relative OG image path into the absolute URL that link-preview
 * crawlers require. Returns null when the host header is unusable, in which
 * case we omit metadataBase rather than emit a localhost URL.
 */
async function requestOrigin(): Promise<URL | null> {
  const h = await headers();
  const first = (name: string) => h.get(name)?.split(",")[0]?.trim() ?? "";
  // pickRequestHost() strips the port, which the origin needs to keep, so read
  // the raw headers here with the same X-Forwarded-Host-first precedence.
  let authority = first("x-forwarded-host") || first("host");
  if (!authority) return null;

  const forwardedProto = first("x-forwarded-proto").toLowerCase();
  // Assume TLS when the proxy doesn't say: a webmail served over plain HTTP is
  // the exception, and an https:// preview URL is the safer guess.
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "https";

  // A proxy (and Next's own dev server) may carry the port separately, leaving
  // X-Forwarded-Host portless. Re-attach it unless it's the default for the scheme.
  if (!authority.includes(":")) {
    const port = first("x-forwarded-port");
    const isDefaultPort = (proto === "https" && port === "443") || (proto === "http" && port === "80");
    if (/^\d+$/.test(port) && !isDefaultPort) authority += `:${port}`;
  }

  try {
    return new URL(`${proto}://${authority}`);
  } catch {
    return null;
  }
}

/** App name, resolved exactly like app/manifest.ts so <head> and manifest agree. */
async function brandedAppName(): Promise<string> {
  return (
    (await brandedValue("appName", "")) ||
    process.env.NEXT_PUBLIC_APP_NAME ||
    "Webmail"
  );
}

export async function generateViewport(): Promise<Viewport> {
  await configManager.ensureLoaded();
  // Chromium uses <meta name="theme-color"> in preference to the manifest's
  // theme_color when coloring an installed desktop PWA's title bar, so a
  // hardcoded value here silently overrode the admin setting (#671). Emit the
  // configured colour instead, honoring per-domain branding like the manifest.
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: (await brandedValue("pwaThemeColor", "")) || "#ffffff",
  };
}

export async function generateMetadata(): Promise<Metadata> {
  await configManager.ensureLoaded();
  // The <head> favicon must honor per-domain branding, exactly like
  // /api/config, app/manifest.ts, and /api/pwa-icon already do. Resolve the
  // request host and prefer its override; fall back to the global
  // admin/env/default value when the host has no favicon override (#585).
  const faviconUrl = await brandedValue("faviconUrl", "/branding/Bulwark_Favicon.svg");
  // Localize the <head> description to match the UI language; a hardcoded
  // English description is another signal that makes Chrome offer to
  // "translate this page". Resolve the locale from the request path, since this
  // layout is above the [locale] segment (see resolveRequestLocale).
  const locale = await resolveRequestLocale();
  const t = await getTranslations({ locale });

  const appName = await brandedAppName();
  // An admin-configured description is branding and outranks the built-in
  // string; without one, use the localized default so the <head> matches the
  // UI language (same precedence as app/manifest.ts).
  const description = (await brandedValue("appDescription", "")) || t("meta_description");
  const origin = await requestOrigin();

  return {
    title: appName,
    description,
    applicationName: appName,
    // A private webmail should not be indexed by search engines. This is opt-in
    // via Settings -> General; the default (false) emits noindex/nofollow.
    robots: configManager.get<boolean>("searchEngineIndexing", false)
      ? { index: true, follow: true }
      : { index: false, follow: false },
    // Link previews are worth emitting even under noindex: pasting the webmail
    // URL into a chat should unfurl as the deployment's own brand, not as a
    // bare link. /api/og-image renders the branded 1200x630 card.
    ...(origin ? { metadataBase: origin } : {}),
    openGraph: {
      type: "website",
      siteName: appName,
      title: appName,
      description,
      locale,
      url: withBasePath("/"),
      images: [
        {
          url: withBasePath("/api/og-image"),
          width: 1200,
          height: 630,
          alt: appName,
          type: "image/png",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: appName,
      description,
      images: [withBasePath("/api/og-image")],
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: appName,
    },
    formatDetection: {
      telephone: false,
    },
    icons: { icon: withBasePath(faviconUrl) },
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await configManager.ensureLoaded();
  const locale = await resolveRequestLocale();
  const nonce = (await headers()).get("x-nonce") ?? "";
  const parentOrigin = process.env.NEXT_PUBLIC_PARENT_ORIGIN || "";
  const themeColorConfigured = await hasExplicitThemeColor();
  const appName = await brandedAppName();

  return (
    <html lang={locale} dir={getLocaleDirection(locale)} suppressHydrationWarning>
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content={appName} />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {parentOrigin && (
          <meta name="parent-origin" content={parentOrigin} />
        )}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const stored = localStorage.getItem('theme-storage');
                  const theme = stored ? JSON.parse(stored).state.theme : 'system';
                  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  const resolved = theme === 'system' ? systemTheme : theme;
                  document.documentElement.classList.remove('light', 'dark');
                  document.documentElement.classList.add(resolved);
                } catch (e) {
                  document.documentElement.classList.add('light');
                }
              })();
            `,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ServiceWorkerRegistration />
        {!themeColorConfigured && <ThemeColorSync />}
        <FaviconBadge />
        {children}
      </body>
    </html>
  );
}
