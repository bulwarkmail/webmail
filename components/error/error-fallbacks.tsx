"use client";

import { AlertCircle, RefreshCw, Inbox, Mail, Settings, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FallbackProps } from "./error-boundary";

/**
 * Full-page error fallback for route-level errors.
 */
export function PageErrorFallback({ error: _error, resetError, t }: FallbackProps) {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="text-center max-w-md px-4">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-red-600 dark:text-red-400" />
        </div>
        <h2 className="text-xl font-semibold text-foreground mb-2">
          {t("page_error_title")}
        </h2>
        <p className="text-muted-foreground mb-6">
          {t("page_error_description")}
        </p>
        <Button onClick={resetError}>
          <RefreshCw className="w-4 h-4 me-2" />
          {t("try_again")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Sidebar error fallback - matches sidebar width (256px).
 */
export function SidebarErrorFallback({ resetError, t }: FallbackProps) {
  return (
    <div className="w-64 h-full border-e border-border bg-secondary flex flex-col items-center justify-center p-4">
      <FolderOpen className="w-10 h-10 text-muted-foreground mb-3" />
      <p className="text-sm text-muted-foreground text-center mb-4">
        {t("sidebar_error")}
      </p>
      <Button variant="outline" size="sm" onClick={resetError}>
        <RefreshCw className="w-3 h-3 me-1" />
        {t("reload")}
      </Button>
    </div>
  );
}

/**
 * Email list error fallback - matches email list panel width (384px).
 */
export function EmailListErrorFallback({ resetError, t }: FallbackProps) {
  return (
    <div className="w-full h-full bg-background flex flex-col items-center justify-center p-4">
      <Inbox className="w-12 h-12 text-muted-foreground mb-3" />
      <p className="text-sm text-muted-foreground text-center mb-4">
        {t("email_list_error")}
      </p>
      <Button variant="outline" size="sm" onClick={resetError}>
        <RefreshCw className="w-4 h-4 me-2" />
        {t("reload_emails")}
      </Button>
    </div>
  );
}

/**
 * Email viewer error fallback - fills remaining space (flex-1).
 */
export function EmailViewerErrorFallback({ resetError, t }: FallbackProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-muted/30 p-8">
      <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
        <Mail className="w-8 h-8 text-red-500" />
      </div>
      <h3 className="text-lg font-medium text-foreground mb-2">
        {t("viewer_error_title")}
      </h3>
      <p className="text-sm text-muted-foreground text-center mb-6 max-w-md">
        {t("viewer_error_description")}
      </p>
      <Button onClick={resetError}>
        <RefreshCw className="w-4 h-4 me-2" />
        {t("try_again")}
      </Button>
    </div>
  );
}

/**
 * Email composer modal error fallback.
 */
export function ComposerErrorFallback({ resetError, t }: FallbackProps) {
  return (
    <div className="flex flex-col h-full bg-background border rounded-lg items-center justify-center p-8">
      <AlertCircle className="w-10 h-10 text-warning mb-3" />
      <p className="text-sm text-muted-foreground text-center mb-4">
        {t("composer_error")}
      </p>
      <Button variant="outline" size="sm" onClick={resetError}>
        {t("retry")}
      </Button>
    </div>
  );
}

/**
 * Settings page error fallback.
 */
export function SettingsErrorFallback({ resetError, t }: FallbackProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <Settings className="w-12 h-12 text-muted-foreground mb-4" />
      <h3 className="text-lg font-medium text-foreground mb-2">
        {t("settings_error_title")}
      </h3>
      <p className="text-sm text-muted-foreground text-center mb-6">
        {t("settings_error_description")}
      </p>
      <Button onClick={resetError}>
        <RefreshCw className="w-4 h-4 me-2" />
        {t("reload_settings")}
      </Button>
    </div>
  );
}
