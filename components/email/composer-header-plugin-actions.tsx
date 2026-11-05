"use client";

import { useMemo } from "react";
import { PluginActions } from "@/components/plugins/plugin-actions";
import { cn } from "@/lib/utils";

/**
 * Plugin buttons in the composer's top bar (surface composer-header-actions),
 * before the composer's own window buttons, in every form of the composer:
 * docked under a message, full, in a window of its own, in a Pro tab and as
 * quick compose. Icons with their label as tooltip; where the bar is narrow
 * (a phone, a small window) they go behind one button that opens them as a
 * menu. The header they sit in is the `composer-head` container.
 */
export function ComposerHeaderPluginActions({ composerId, className }: { composerId: string | null; className?: string }) {
  const context = useMemo(() => ({ composerId }), [composerId]);
  return (
    <>
      <PluginActions
        surface="composer-header-actions"
        context={context}
        compact
        className={cn("hidden shrink-0 flex-nowrap @[34rem]/composer-head:inline-flex", className)}
      />
      <PluginActions
        surface="composer-header-actions"
        context={context}
        overflow
        className={cn("shrink-0 @[34rem]/composer-head:hidden", className)}
      />
    </>
  );
}
