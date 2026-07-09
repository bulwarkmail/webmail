import type { Metadata, Viewport } from "next";
import { getLocaleDirection } from "@/i18n/direction";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { configManager } from "@/lib/admin/config-manager";
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export async function generateMetadata(): Promise<Metadata> {
  await configManager.ensureLoaded();
  // The <head> favicon must honor per-domain branding, exactly like
  // /api/config, app/manifest.ts, and /api/pwa-icon already do. Resolve the
  // request host and prefer its override; fall back to the global
  // admin/env/default value when the host has no favicon override (#585).
  const host = pickRequestHost(await headers());
  const domainOverride = matchDomainBranding(
    host,
    parseDomainBranding(configManager.get<unknown>("domainBranding", [])),
  ).faviconUrl;
  const faviconUrl =
    domainOverride && domainOverride.length > 0
      ? domainOverride
      : configManager.get<string>("faviconUrl", "/branding/Bulwark_Favicon.svg");
  // Localize the <head> description to match the UI language; a hardcoded
  // English description is another signal that makes Chrome offer to
  // "translate this page". Resolve the locale from the request path, since this
  // layout is above the [locale] segment (see resolveRequestLocale).
  const locale = await resolveRequestLocale();
  const t = await getTranslations({ locale });

  return {
    title: process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || "Webmail",
    description: t("meta_description"),
    // A private webmail should not be indexed by search engines. This is opt-in
    // via Settings -> General; the default (false) emits noindex/nofollow.
    robots: configManager.get<boolean>("searchEngineIndexing", false)
      ? { index: true, follow: true }
      : { index: false, follow: false },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || "Webmail",
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
  const locale = await resolveRequestLocale();
  const nonce = (await headers()).get("x-nonce") ?? "";
  const parentOrigin = process.env.NEXT_PUBLIC_PARENT_ORIGIN || "";

  return (
    <html lang={locale} dir={getLocaleDirection(locale)} suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#ffffff" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-title"
          content={process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || "Webmail"}
        />
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
        {children}
      </body>
    </html>
  );
}
