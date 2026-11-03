"use client";

import { useCallback, useEffect, useRef, DragEvent } from "react";
import { canDragNativeFiles, copyFilesToClipboard, startNativeFileDrag } from "@/lib/desktop/file-drag";

// Chromium ships the `DownloadURL` DataTransfer entry, which the OS reads on
// drop to materialize a real file. Firefox and Safari ignore it, so we only
// enable drag-out where it actually works.
//
// Every message row asks, on every render; the answer is kept per user agent.
let dragOutSupport: { ua: string; supported: boolean } | null = null;

export function isDragOutSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent || "";
  if (dragOutSupport?.ua === agent) return dragOutSupport.supported;
  const supported = detectDragOutSupport();
  dragOutSupport = { ua: agent, supported };
  return supported;
}

function detectDragOutSupport(): boolean {
  const uaData = (navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData;
  if (uaData?.brands?.length) {
    return uaData.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Brave|Opera/i.test(b.brand));
  }
  const ua = navigator.userAgent || "";
  if (/Firefox|FxiOS/.test(ua)) return false;
  if (/^((?!chrome|android).)*safari/i.test(ua)) return false;
  return /Chrome|Chromium|Edg\//.test(ua);
}

export interface AttachmentDragSource {
  name: string;
  type: string;
  getBlobUrl: () => Promise<string | null>;
  /** The bytes themselves, for the desktop app's native drag. */
  getBlob?: () => Promise<Blob | null>;
}

export interface UseAttachmentDragResult {
  draggable: boolean;
  onPointerEnter: () => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: (e: DragEvent<HTMLDivElement>) => void;
  /** The desktop app: put the file on the clipboard, for pasting into Explorer or Finder. */
  onCopyAsFile?: () => Promise<boolean>;
}

const NOOP_HANDLERS: UseAttachmentDragResult = {
  draggable: false,
  onPointerEnter: () => {},
  onDragStart: () => {},
  onDragEnd: () => {},
};

export function useAttachmentDrag(
  source: AttachmentDragSource,
  enabled: boolean,
): UseAttachmentDragResult {
  const urlRef = useRef<string | null>(null);
  const ownedRef = useRef<boolean>(false);
  const inFlightRef = useRef<Promise<string | null> | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const nativeDrag = canDragNativeFiles() && !!source.getBlob;

  useEffect(() => {
    return () => {
      if (urlRef.current && ownedRef.current) {
        URL.revokeObjectURL(urlRef.current);
      }
      urlRef.current = null;
      ownedRef.current = false;
      inFlightRef.current = null;
    };
  }, []);

  const prefetch = useCallback(() => {
    if (!enabled) return;
    if (nativeDrag) {
      if (blobRef.current || inFlightRef.current) return;
      inFlightRef.current = source.getBlob!()
        .then((blob) => {
          blobRef.current = blob;
          return null;
        })
        .catch(() => null)
        .finally(() => {
          inFlightRef.current = null;
        });
      return;
    }
    if (urlRef.current || inFlightRef.current) return;
    inFlightRef.current = source
      .getBlobUrl()
      .then((url) => {
        if (url && !urlRef.current) {
          urlRef.current = url;
          // Mark as owned so we revoke on unmount. Callers that hand back a
          // shared URL (e.g. a cached thumbnail blob URL) can return the same
          // string each time - we still revoke once on unmount.
          ownedRef.current = true;
        }
        return url;
      })
      .catch(() => null)
      .finally(() => {
        inFlightRef.current = null;
      });
  }, [enabled, source, nativeDrag]);

  const handleDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const url = urlRef.current;
      const name = source.name || "download";
      const type = source.type || "application/octet-stream";

      // In the desktop app the OS's own drag, with the real file on disk first. The bytes
      // aren't here yet: fetch them for the next try, as below.
      if (nativeDrag) {
        e.preventDefault();
        if (blobRef.current) void startNativeFileDrag([{ name, blob: blobRef.current }]);
        else prefetch();
        return;
      }

      if (!url) {
        // Blob isn't materialized yet. Kick off the fetch so the next attempt
        // works, but cancel this drag so the user doesn't get a silent failure
        // where the OS receives no file.
        prefetch();
        e.preventDefault();
        return;
      }

      // `DownloadURL` format: <mime>:<filename>:<url>. The filename must be
      // raw - URL-encoding it lands literally on disk (`%20` instead of a
      // space). Callers are expected to sanitise reserved chars (`:` etc.)
      // beforehand.
      e.dataTransfer.setData("DownloadURL", `${type}:${name}:${url}`);
      e.dataTransfer.effectAllowed = "copyMove";
    },
    [source.name, source.type, prefetch, nativeDrag],
  );

  const handleDragEnd = useCallback(() => {
    // Keep the blob URL around briefly - Chromium asynchronously fetches the
    // blob: URL after dragend fires, so revoking immediately races the OS.
    if (urlRef.current && ownedRef.current) {
      const url = urlRef.current;
      urlRef.current = null;
      ownedRef.current = false;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }, []);

  const copyAsFile = useCallback(async () => {
    const blob = blobRef.current ?? await source.getBlob?.();
    return blob ? copyFilesToClipboard([{ name: source.name || "download", blob }]) : false;
  }, [source]);

  if (!enabled) return NOOP_HANDLERS;

  return {
    draggable: true,
    onPointerEnter: prefetch,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
    ...(nativeDrag ? { onCopyAsFile: copyAsFile } : {}),
  };
}
