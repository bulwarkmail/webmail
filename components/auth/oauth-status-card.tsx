"use client";

/**
 * Branded full-screen status card for OAuth callback pages.
 */

import { Button } from "@/components/ui/button";
import { useConfig } from "@/hooks/use-config";
import { withBasePath } from "@/lib/browser-navigation";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme-store";
import type { AppIcon } from "@/components/icons";
import { Loader2 } from "@/components/icons";

export interface OAuthStatusAction {
  label: string;
  onClick: () => void;
}

export interface OAuthStatusCardProps {
  /** Icon badge shown below the logo (defaults to a spinner) */
  icon?: AppIcon;
  /** Tailwind color classes for the icon badge, e.g. "bg-green-500/10 text-green-600" */
  iconClassName?: string;
  title: string;
  message?: string;
  action?: OAuthStatusAction;
  /** Extra content rendered below the message (e.g. detail lines) */
  children?: React.ReactNode;
}

export function OAuthStatusCard({
  icon: Icon,
  iconClassName,
  title,
  message,
  action,
  children,
}: OAuthStatusCardProps) {
  const {
    appName,
    appLogoLightUrl,
    appLogoDarkUrl,
    loginLogoLightUrl,
    loginLogoDarkUrl,
  } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);

  // Same logo resolution order as the admin layout: app logo first, then the
  // login logo (which has Bulwark defaults), so an unbranded instance still
  // shows the Bulwark mark.
  const logoUrl = withBasePath(
    resolvedTheme === "dark"
      ? appLogoDarkUrl || appLogoLightUrl || loginLogoDarkUrl
      : appLogoLightUrl || appLogoDarkUrl || loginLogoLightUrl,
  );

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-linear-to-br from-background via-background to-muted/20 px-4 py-10">
      <div className="w-full max-w-100 mx-auto">
        <div className="rounded-2xl border border-border/60 bg-background/80 backdrop-blur-sm shadow-xl shadow-black/5 dark:shadow-black/20 overflow-hidden">
          {/* Header with instance branding */}
          <div className="px-8 pt-10 pb-6 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 mb-5">
              <img
                src={logoUrl}
                alt={appName}
                className="max-w-16 max-h-16 object-contain"
              />
            </div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">
              {appName}
            </h1>

            {/* Status badge */}
            <div
              className={cn(
                "mt-6 inline-flex items-center justify-center w-14 h-14 rounded-2xl",
                iconClassName ?? "bg-primary/10 text-primary",
              )}
            >
              {Icon ? (
                <Icon className="w-7 h-7" />
              ) : (
                <Loader2 className="w-7 h-7 animate-spin" />
              )}
            </div>
          </div>

          {/* Status body */}
          <div className="px-8 pb-10 pt-0 text-center">
            <p className="text-base font-medium text-foreground">{title}</p>
            {message && (
              <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                {message}
              </p>
            )}
            {children}
            {action && (
              <Button
                variant="outline"
                className="mt-6"
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
