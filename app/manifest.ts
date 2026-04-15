import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  const appName =
    process.env.APP_NAME ||
    process.env.NEXT_PUBLIC_APP_NAME ||
    "Bulwark Webmail";

  const shortName = process.env.APP_SHORT_NAME || appName;
  const description =
    process.env.APP_DESCRIPTION ||
    "A modern webmail client built for Stalwart Mail Server";
  const themeColor = process.env.PWA_THEME_COLOR || "#ffffff";
  const backgroundColor = process.env.PWA_BACKGROUND_COLOR || "#ffffff";

  // If PWA_ICON_URL or FAVICON_URL is configured, serve dynamically resized PNGs
  // via /api/pwa-icon/[size]. Otherwise fall back to the default Bulwark PNGs.
  const hasCustomIcon = !!(process.env.PWA_ICON_URL || process.env.FAVICON_URL);

  const icons: MetadataRoute.Manifest["icons"] = hasCustomIcon
    ? [
        { src: "/api/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/api/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/api/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: "/api/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ]
    : [
        { src: "/icon-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icon-maskable-light-192x192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: "/icon-maskable-light-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        { src: "/icon-maskable-dark-192x192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: "/icon-maskable-dark-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ];

  return {
    name: appName,
    short_name: shortName,
    description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    theme_color: themeColor,
    background_color: backgroundColor,
    icons,
    categories: ["productivity"],
    screenshots: [
      { src: "/screenshot-540x720.png", sizes: "540x720", type: "image/png" },
      { src: "/screenshot-1280x720.png", sizes: "1280x720", type: "image/png" },
    ],
  };
}
