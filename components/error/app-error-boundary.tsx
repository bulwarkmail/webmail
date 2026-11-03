"use client";

import type { ReactNode } from "react";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { useIsMobile } from "@/hooks/use-media-query";
import { ErrorBoundary, type FallbackProps } from "./error-boundary";
import { PageErrorFallback, SettingsErrorFallback } from "./error-fallbacks";

function AppErrorLayout({ kind, ...props }: FallbackProps & { kind: "page" | "settings" }) {
  const isMobile = useIsMobile();
  const Fallback = kind === "settings" ? SettingsErrorFallback : PageErrorFallback;
  // The navigation stays, so one app crashing doesn't strand the user in it.
  return (
    <div className="flex h-dvh bg-background pt-[var(--app-top-inset)]">
      {!isMobile && (
        <div className="w-14 bg-secondary flex flex-col flex-shrink-0 border-e border-border">
          <NavigationRail collapsed />
        </div>
      )}
      <div className="flex flex-col flex-1 min-w-0">
        <Fallback {...props} />
        {isMobile && <NavigationRail orientation="horizontal" />}
      </div>
    </div>
  );
}

/**
 * Wraps one app (Calendar, Contacts, Files, Settings): a crash in it shows
 * the shared error fallback next to the navigation, instead of the route
 * error page in place of everything.
 */
export function AppErrorBoundary({ children, kind = "page" }: { children: ReactNode; kind?: "page" | "settings" }) {
  return (
    <ErrorBoundary fallback={(props) => <AppErrorLayout kind={kind} {...props} />}>
      {children}
    </ErrorBoundary>
  );
}
