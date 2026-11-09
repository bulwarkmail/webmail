"use client";

import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { listenForPrinting, usePrintStore } from "@/stores/print-store";
import { Watermark, useWatermarkText } from "@/components/device/watermark";
import { useIsFocusedProTab, useIsPaneScoped } from "@/hooks/use-pane-context";
import { useActivePrintTheme } from "@/lib/print/active-print-theme";
import { printPageMargin, readPrintThemeVars } from "@/lib/print/print-theme";

export type PrintOrientation = "portrait" | "landscape";

/** Prints this page's copy on Ctrl+P while the page is mounted. */
export function usePrintListener(): void {
  useEffect(() => listenForPrinting(), []);
}

/** True while the browser prints (or is about to): the page renders its print copy then. */
export function usePrinting(): boolean {
  return usePrintStore((s) => s.printing);
}

interface PrintRootProps {
  /** The paper orientation the copy is laid out for; the dialog may still change it. */
  orientation: PrintOrientation;
  /** The document title while printing: browsers use it as the PDF's file name and page header. */
  title?: string;
  /**
   * The page margin may come from the theme (--print-page-margin). Only for
   * copies that flow over pages: the calendar views fill one sheet each.
   */
  themeMargin?: boolean;
  children: ReactNode;
}

/**
 * The print copy of a page. It sits next to the app in <body> and, in print
 * media, replaces it (app/print.css), so no app chrome, open menu or toast
 * reaches the paper. On screen it is never shown.
 */
export function PrintRoot({ orientation, title, themeMargin, children }: PrintRootProps) {
  // Organisation > Devices > Watermark: on every printed page.
  const watermark = useWatermarkText(undefined, { strictest: true });
  // Pro keeps every open tab mounted, and each would add its copy: only the
  // tab in front goes on paper.
  const isPaneScoped = useIsPaneScoped();
  const isFocusedTab = useIsFocusedProTab();
  const shown = !isPaneScoped || isFocusedTab;
  useLayoutEffect(() => {
    if (!title || !shown) return;
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title, shown]);

  // The print style the user picked (a plugin's): its rules are scoped to
  // [data-print-theme], so they reach this copy and nothing else.
  const printTheme = useActivePrintTheme();

  if (!shown) return null;

  const margin = (themeMargin && (printTheme?.pageMargin || printPageMargin(readPrintThemeVars()["--print-page-margin"]))) || "12mm";
  return createPortal(
    <div data-print-root="" data-orientation={orientation} className="pr-root" {...(printTheme ? { "data-print-theme": printTheme.key } : {})}>
      <style>{`@page { size: ${orientation}; margin: ${margin}; }`}</style>
      {printTheme?.css ? <style data-print-theme-css="">{printTheme.css}</style> : null}
      <Watermark text={watermark} fixed />
      {children}
    </div>,
    document.body,
  );
}
