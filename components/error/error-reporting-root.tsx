"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { fetchConfig } from "@/hooks/use-config";
import { installGlobalHandlers, recordNavigation } from "@/lib/error-reporting/client";

/**
 * Starts browser error reporting: window.onerror and unhandled rejections,
 * and a breadcrumb per route change (the route's area only, never the URL).
 * Whether anything is sent is decided by the config (/api/config, or Lite's
 * policy.json); until it arrives, reports wait, and with reporting off they
 * are dropped. Renders nothing.
 */
export function ErrorReportingRoot() {
  const pathname = usePathname();

  useEffect(() => {
    installGlobalHandlers();
    // Cached after the first fetch; this only makes sure it happens on pages
    // that don't read the config themselves (admin, setup).
    void fetchConfig().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (pathname) recordNavigation(pathname);
  }, [pathname]);

  return null;
}
