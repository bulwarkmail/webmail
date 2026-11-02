import type { MetadataRoute } from "next";
import { headers } from "next/headers";
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

type ExtendedManifest = MetadataRoute.Manifest & {
  protocol_handlers?: WebAppProtocolHandler[];
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

  const host = pickRequestHost(await headers());
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

  return {
    name: appName,
    short_name: shortName,
    description,
    start_url: withBase("/"),
    scope: withBase("/"),
    display: "standalone",
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
    launch_handler: {
      client_mode: ["focus-existing", "navigate-new"],
    },
  };
}
