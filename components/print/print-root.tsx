"use client";

import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { listenForPrinting, usePrintStore } from "@/stores/print-store";
import { Watermark, useWatermarkText } from "@/components/device/watermark";

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
  children: ReactNode;
}

/**
 * The print copy of a page. It sits next to the app in <body> and, in print
 * media, replaces it (app/print.css), so no app chrome, open menu or toast
 * reaches the paper. On screen it is never shown.
 */
export function PrintRoot({ orientation, title, children }: PrintRootProps) {
  // Organisation > Devices > Watermark: on every printed page.
  const watermark = useWatermarkText(undefined, { strictest: true });
  useLayoutEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);

  return createPortal(
    <div data-print-root="" data-orientation={orientation} className="pr-root">
      <style>{`@page { size: ${orientation}; margin: 12mm; }`}</style>
      <Watermark text={watermark} fixed />
      {children}
    </div>,
    document.body,
  );
}
