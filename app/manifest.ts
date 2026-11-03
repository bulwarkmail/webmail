import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { localeFromAcceptLanguage } from "@/i18n/locale-matcher";
import { routing } from "@/i18n/routing";
import { configManager } from "@/lib/admin/config-manager";
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
  type BrandingOverrideKey,
} from "@/lib/admin/domain-branding";

export const dynamic = "force-dynamic";

type WebAppProtocolHandler = {
  protocol: string;
  url: string;
};

type WebAppFileHandler = {
  action: string;
  accept: Record<string, string[]>;
};

type WebAppShareTarget = {
  action: string;
  method: "POST";
  enctype: "multipart/form-data";
  params: {
    title: string;
    text: string;
    url: string;
    files: Array<{ name: string; accept: string[] }>;
  };
};

type ExtendedManifest = Omit<MetadataRoute.Manifest, "display_override"> & {
  display_override?: Array<"window-controls-overlay" | "standalone" | "minimal-ui" | "browser" | "fullscreen">;
  protocol_handlers?: WebAppProtocolHandler[];
  file_handlers?: WebAppFileHandler[];
  share_target?: WebAppShareTarget;
  launch_handler?: {
    client_mode?: "navigate-existing" | "auto" | "focus-existing" | "navigate-new"
      | Array<"navigate-existing" | "auto" | "focus-existing" | "navigate-new">;
  };
};

// Manifest paths must include the deployment subpath - browsers resolve them
// against the document origin, not the manifest's location, and Next.js does
// not auto-prefix string literals inside MetadataRoute payloads.
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
const withBase = (p: string) => `${BASE_PATH}${p}`;

export default async function manifest(): Promise<ExtendedManifest> {
  await configManager.ensureLoaded();

  const requestHeaders = await headers();
  const host = pickRequestHost(requestHeaders);
  const domainOverrides = matchDomainBranding(
    host,
    parseDomainBranding(configManager.get<unknown>("domainBranding", [])),
  );
  const branded = <T,>(key: BrandingOverrideKey, fallback: T): T => {
    const override = domainOverrides[key];
    if (typeof override === "string" && override.length > 0) return override as T;
    return configManager.get<T>(key, fallback);
  };

  const appName =
    branded<string>("appName", "") ||
    process.env.NEXT_PUBLIC_APP_NAME ||
    "Bulwark Webmail";

  const shortName = branded<string>("appShortName", "") || appName;
  const description =
    branded<string>("appDescription", "") ||
    "Self-hosted webmail for mail, calendar, contacts and files, built on JMAP";
  const themeColor = branded<string>("pwaThemeColor", "") || "#ffffff";
  const backgroundColor = branded<string>("pwaBackgroundColor", "") || "#ffffff";

  // If pwaIconUrl or faviconUrl was explicitly configured (admin override,
  // env var, or per-domain override), serve dynamically resized PNGs via
  // /api/pwa-icon/[size]. Otherwise fall back to the static Bulwark PNGs -
  // sources marked "default" are the built-in placeholder paths and not
  // real custom icons.
  const sources = configManager.getAllWithSources();
  const hasCustomIcon =
    !!domainOverrides.pwaIconUrl ||
    !!domainOverrides.faviconUrl ||
    sources.pwaIconUrl?.source !== "default" ||
    sources.faviconUrl?.source !== "default";

  const icons: MetadataRoute.Manifest["icons"] = hasCustomIcon
    ? [
        { src: withBase("/api/pwa-icon/192"), sizes: "192x192", type: "image/png", purpose: "any" },
        { src: withBase("/api/pwa-icon/512"), sizes: "512x512", type: "image/png", purpose: "any" },
        { src: withBase("/api/pwa-icon/192"), sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: withBase("/api/pwa-icon/512"), sizes: "512x512", type: "image/png", purpose: "maskable" },
      ]
    : [
        { src: withBase("/icon-192x192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
        { src: withBase("/icon-512x512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
        { src: withBase("/icon-maskable-light-192x192.png"), sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: withBase("/icon-maskable-light-512x512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
        { src: withBase("/icon-maskable-dark-192x192.png"), sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: withBase("/icon-maskable-dark-512x512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
      ];

  // Shortcut names show in the OS menu, in the language the browser asks in.
  const t = await getTranslations({
    locale: localeFromAcceptLanguage(requestHeaders.get("accept-language"), routing.locales) ?? routing.defaultLocale,
    namespace: "pwaLaunch",
  });
  const shortcutIcons = [{
    src: withBase(hasCustomIcon ? "/api/pwa-icon/192" : "/icon-192x192.png"),
    sizes: "192x192",
    type: "image/png",
  }];

  return {
    name: appName,
    short_name: shortName,
    description,
    start_url: withBase("/"),
    scope: withBase("/"),
    display: "standalone",
    // The page draws up to the top of the window, next to the native controls
    // (components/layout/window-controls-host.tsx). `display` is the fallback.
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "portrait-primary",
    theme_color: themeColor,
    background_color: backgroundColor,
    icons,
    categories: ["productivity"],
    // Use admin-uploaded screenshots when configured (per-domain override,
    // admin/env global; resized on the fly via /api/pwa-screenshot/[variant]);
    // otherwise fall back to the built-in Bulwark screenshots from public/.
    screenshots: (() => {
      const hasMobile =
        !!domainOverrides.pwaScreenshotMobileUrl ||
        sources.pwaScreenshotMobileUrl?.source !== "default";
      const hasDesktop =
        !!domainOverrides.pwaScreenshotDesktopUrl ||
        sources.pwaScreenshotDesktopUrl?.source !== "default";
      return [
        hasMobile
          ? { src: withBase("/api/pwa-screenshot/mobile"), sizes: "540x720", type: "image/png" }
          : { src: withBase("/screenshot-540x720.png"), sizes: "540x720", type: "image/png" },
        hasDesktop
          ? { src: withBase("/api/pwa-screenshot/desktop"), sizes: "1280x720", type: "image/png" }
          : { src: withBase("/screenshot-1280x720.png"), sizes: "1280x720", type: "image/png" },
      ];
    })(),
    protocol_handlers: [
      { protocol: "mailto", url: withBase("/protocol/mailto?url=%s") },
      { protocol: "webcal", url: withBase("/protocol/webcal?url=%s") },
    ],
    shortcuts: [
      { name: t("shortcut_new_message"), url: withBase("/?compose=1"), icons: shortcutIcons },
      { name: t("shortcut_calendar"), url: withBase("/calendar"), icons: shortcutIcons },
      { name: t("shortcut_contacts"), url: withBase("/contacts"), icons: shortcutIcons },
    ],
    // Where a file goes is decided by its type, in lib/launch-handoff.ts. The
    // actions are the pages a new window should start on.
    file_handlers: [
      { action: withBase("/mail"), accept: { "message/rfc822": [".eml"] } },
      { action: withBase("/calendar"), accept: { "text/calendar": [".ics", ".ical"] } },
      { action: withBase("/contacts"), accept: { "text/vcard": [".vcf", ".vcard"], "text/x-vcard": [".vcf", ".vcard"] } },
    ],
    // Not under /api/: proxy.ts refuses a POST from outside there. The service
    // worker takes it (public/sw.js); without one, app/(main)/protocol/share.
    share_target: {
      action: withBase("/protocol/share"),
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: "files", accept: ["*/*"] }],
      },
    },
    launch_handler: {
      client_mode: ["focus-existing", "navigate-new"],
    },
  };
}
