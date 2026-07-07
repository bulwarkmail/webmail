"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

// Real inline PDF preview for mobile browsers. Android Chrome / iOS WebKit have
// no native inline PDF viewer, so the desktop <iframe src=blob:> approach
// renders a blank frame. pdf.js rasterises each page to a <canvas> in pure JS,
// so it works everywhere regardless of native PDF support.
//
// This component is dynamic-imported (ssr:false) only on the mobile PDF path,
// and it dynamic-imports pdfjs-dist itself, so the (~hundreds of KB) library +
// worker never reach the desktop bundle.

// iOS WebKit caps total canvas area (~16 MP) and is memory-sensitive; keep each
// page's backing store well under that so large pages don't render blank. The
// backing store is rendered at ~2x the fit width (dpr), which also gives the
// double-tap zoom some headroom before CSS upscaling softens the text.
const MAX_CANVAS_AREA = 4_000_000; // ~4 MP per page

// Double-tap zoom steps: fit -> 2x -> 3x -> fit. Implemented as the page
// container's CSS width (so panning is native scrolling, not a transform).
const ZOOM_STEPS = [1, 2, 3];
const MAX_ZOOM = 4; // pinch can go a bit beyond the double-tap steps
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 30; // px

export function PdfMobileViewer({ url }: { url: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const zoom = useRef({ step: 0, scale: 1 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const t = useTranslations("files");

  // Render the PDF pages to canvases.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;

    // Reset zoom for a freshly loaded document.
    zoom.current = { step: 0, scale: 1 };
    if (pagesRef.current) pagesRef.current.style.width = "100%";

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();

        loadingTask = pdfjs.getDocument({ url });
        const doc = await loadingTask.promise;
        if (cancelled) return;

        const pages = pagesRef.current;
        if (!pages) return;
        pages.replaceChildren();

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssWidth = Math.min(pages.clientWidth || 320, 900);

        for (let n = 1; n <= doc.numPages; n++) {
          if (cancelled) return;
          const page = await doc.getPage(n);
          const baseVp = page.getViewport({ scale: 1 });
          let scale = (cssWidth / baseVp.width) * dpr;
          const area = baseVp.width * scale * (baseVp.height * scale);
          if (area > MAX_CANVAS_AREA) scale *= Math.sqrt(MAX_CANVAS_AREA / area);
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          canvas.style.display = "block";
          canvas.style.margin = "0 auto 8px";
          canvas.style.background = "#fff";
          pages.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
        }
        if (!cancelled) setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      void loadingTask?.destroy().catch(() => {});
    };
  }, [url]);

  // Gesture zoom. 1-finger double-tap cycles the steps (fit -> 2x -> 3x ->
  // fit); 2-finger pinch zooms continuously up to MAX_ZOOM. Both drive a
  // per-page CSS-width zoom that pans via native scrolling and re-centre on the
  // gesture point. touch-action (pan-x pan-y) keeps 1-finger panning native
  // while disabling the browser's own pinch/double-tap page zoom, which we
  // replace here.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const distance = (a: Touch, b: Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    // Apply an absolute zoom scale, keeping (cx, cy) [relative to root] under
    // the same content point.
    const applyZoom = (target: number, cx: number, cy: number) => {
      const pages = pagesRef.current;
      if (!pages) return;
      const next = Math.max(1, Math.min(MAX_ZOOM, target));
      const ratio = next / zoom.current.scale;
      if (ratio === 1) return;
      pages.style.width = `${next * 100}%`;
      void root.offsetWidth; // force reflow so the new scroll range is live
      root.scrollLeft = (root.scrollLeft + cx) * ratio - cx;
      root.scrollTop = (root.scrollTop + cy) * ratio - cy;
      zoom.current.scale = next;
    };

    let lastTap = 0;
    let lastX = 0;
    let lastY = 0;
    let pinching = false;
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let didPinch = false;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinching = true;
        didPinch = true;
        pinchStartDist = distance(e.touches[0], e.touches[1]) || 1;
        pinchStartScale = zoom.current.scale;
      }
    };

    const onMove = (e: TouchEvent) => {
      if (!pinching || e.touches.length !== 2) return;
      e.preventDefault(); // take over the 2-finger gesture from native pan
      const rect = root.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      applyZoom(pinchStartScale * (distance(e.touches[0], e.touches[1]) / pinchStartDist), cx, cy);
    };

    const onEnd = (e: TouchEvent) => {
      if (pinching && e.touches.length < 2) {
        pinching = false;
        // Snap the step index to the current scale so double-tap stays sensible.
        const s = zoom.current.scale;
        zoom.current.step = s <= 1.01 ? 0 : s < 3 ? 1 : 2;
      }
      if (e.touches.length > 0) return; // fingers still down
      if (didPinch) {
        didPinch = false; // a pinch is not a tap
        return;
      }
      if (e.changedTouches.length !== 1) return;
      const touch = e.changedTouches[0];
      const now = e.timeStamp;
      const isDouble =
        now - lastTap < DOUBLE_TAP_MS &&
        Math.abs(touch.clientX - lastX) < DOUBLE_TAP_SLOP &&
        Math.abs(touch.clientY - lastY) < DOUBLE_TAP_SLOP;
      if (!isDouble) {
        lastTap = now;
        lastX = touch.clientX;
        lastY = touch.clientY;
        return;
      }
      lastTap = 0; // consume so a third tap starts fresh
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      zoom.current.step = (zoom.current.step + 1) % ZOOM_STEPS.length;
      applyZoom(ZOOM_STEPS[zoom.current.step], touch.clientX - rect.left, touch.clientY - rect.top);
    };

    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd, { passive: false });
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="w-full h-full overflow-auto"
      // Allow panning, but disable the browser's pinch/double-tap page zoom so
      // our own double-tap zoom drives the PDF instead of the whole modal.
      style={{ touchAction: "pan-x pan-y" }}
    >
      {status === "loading" && (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {status === "error" && (
        // pdf.js couldn't render this document (corrupt/encrypted, worker load
        // failure, ...). Offer the OS/native viewer instead of a stuck frame.
        <div className="flex justify-center py-10">
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="w-4 h-4 me-2" />
            {t("open_in_new_tab")}
          </Button>
        </div>
      )}
      <div ref={pagesRef} className="w-full" />
    </div>
  );
}
