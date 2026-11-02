"use client";

import { useState, useEffect, useRef } from "react";
import { generateUUID } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { X, Download, Loader2, ExternalLink } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ZoomableImage } from "@/components/files/zoomable-image";
import { getFilePreviewKind, imageBlobUrl, isMimeTypeSafeForInlinePreview, previewBlobType } from "@/lib/file-preview";
import dynamic from "next/dynamic";
import { EmlPreview, type ParsedEml } from "@/components/files/eml-preview";
import { FilePreviewPluginSection } from "@/components/files/file-preview-plugin-section";
import { MarkdownView } from "@/components/xenaxio/markdown-view";
import { LinkifiedText } from "@/components/ui/linkified-text";
import { canOpenUrlInNewWindow } from "@/lib/standalone-display";
import { emailIframeCsp, sanitizeEmailBodyForIframe } from "@/lib/email-sanitization";
import { useSettingsStore } from "@/stores/settings-store";
import type { FileResourceView } from "@/lib/plugin-types";

/**
 * An HTML attachment as a document for a fully locked frame (sandbox="",
 * srcdoc): the sender's markup sanitised like a mail body, remote content
 * blocked under the same setting, and a CSP as the network backstop. It used
 * to be shown from a text/html blob: URL, which is a document of the webmail
 * origin: a link inside the sandboxed frame resolved to that URL, and dragging
 * or copying it into a new tab ran the sender's script as the webmail
 * (the mechanism of GHSA-xvjh-v9c6-qcvc), while nothing sanitised it or
 * stopped its remote images and meta refreshes.
 */
export function htmlAttachmentDocument(html: string, blockRemote: boolean): string {
  const body = sanitizeEmailBodyForIframe(html, blockRemote).html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${emailIframeCsp(blockRemote)}"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`;
}

// pdf.js-based inline viewer for mobile (no native inline PDF viewer). Loaded
// only on the mobile PDF path so pdfjs-dist + its worker never reach the
// desktop bundle.
const PdfMobileViewer = dynamic(
  () => import("@/components/files/pdf-mobile-viewer").then((m) => m.PdfMobileViewer),
  { ssr: false },
);

interface FilePreviewModalProps {
  name: string;
  onClose: () => void;
  onDownload: () => Promise<void> | void;
  getFileContent: () => Promise<{ blob: Blob; contentType: string }>;
  /** The previewed file as plugins see it (file-preview-section). */
  file?: FileResourceView | null;
}

// Closing one preview can leave an asynchronous Back traversal in flight.
// A replacement must not install its popstate listener until that completes.
let pendingPreviewHistoryBack: Promise<void> | null = null;

export function FilePreviewModal({ name, onClose, onDownload, getFileContent, file }: FilePreviewModalProps) {
  const t = useTranslations("files");
  const [content, setContent] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [resolvedFileType, setResolvedFileType] = useState(() => getFilePreviewKind(name));
  const [pdfInlineSupported, setPdfInlineSupported] = useState(true);
  // Whether the resolved blob MIME is inert enough to open as a top-level
  // navigation. Blob URLs inherit our origin, so opening a script-bearing type
  // (text/html, image/svg+xml, ...) in a new tab would execute it in-origin.
  const [canOpenInNewTab, setCanOpenInNewTab] = useState(false);
  const [emlContent, setEmlContent] = useState<ParsedEml | null>(null);
  // The PDF blob itself, kept alongside its object URL: the pdf.js mobile
  // viewer needs the bytes, because fetching the blob: URL is blocked by CSP
  // connect-src (#871). The URL is still what the <iframe> and the
  // open-in-new-tab fallback use.
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [htmlDoc, setHtmlDoc] = useState<string | null>(null);
  const blockRemote = useSettingsStore((state) => state.externalContentPolicy) !== "allow";

  // Decide whether to render the PDF in a plain <iframe> (desktop) or with the
  // pdf.js canvas viewer (mobile). navigator.pdfViewerEnabled is the standard
  // signal and correctly reports false on Android Chrome (no inline viewer).
  // iOS Safari is the exception: it reports true (it can show PDFs on top-frame
  // navigation) yet renders only the FIRST page inside an <iframe> - a
  // long-standing WebKit limitation - so it must use pdf.js too. Detect iOS
  // (incl. iPadOS, which spoofs a "Macintosh" UA but exposes touch points).
  useEffect(() => {
    const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
    const isIOS =
      /iPad|iPhone|iPod/.test(nav.userAgent) ||
      (nav.maxTouchPoints > 1 && /Macintosh/.test(nav.userAgent));
    if (isIOS) {
      setPdfInlineSupported(false);
    } else if (typeof nav.pdfViewerEnabled === "boolean") {
      setPdfInlineSupported(nav.pdfViewerEnabled);
    }
  }, []);

  // Keep the latest onClose for the back-button handler without re-subscribing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Defer history setup so Strict Mode's setup/cleanup/setup replay can
  // cancel the first setup without scheduling a browser Back traversal.
  useEffect(() => {
    const entryId = generateUUID();
    let cancelled = false;
    let started = false;
    let poppedByBack = false;
    const onPop = () => {
      poppedByBack = true;
      onCloseRef.current();
    };
    const timer = window.setTimeout(async () => {
      if (pendingPreviewHistoryBack) await pendingPreviewHistoryBack;
      if (cancelled) return;
      window.history.pushState({ ...window.history.state, __filePreview: entryId }, "");
      started = true;
      window.addEventListener("popstate", onPop);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPop);
      if (started && !poppedByBack && window.history.state?.__filePreview === entryId) {
        pendingPreviewHistoryBack = new Promise<void>(resolve => {
          window.addEventListener("popstate", () => {
            pendingPreviewHistoryBack = null;
            resolve();
          }, { once: true });
        });
        window.history.back();
      }
    };
  }, []);

  const fileType = resolvedFileType;

  useEffect(() => {
    let cancelled = false;
    let revokeUrl: string | null = null;

    setContent(null);
    setObjectUrl(null);
    setCanOpenInNewTab(false);
    setEmlContent(null);
    setPdfBlob(null);
    setHtmlDoc(null);
    setLoading(true);
    setError(false);
    setResolvedFileType(getFilePreviewKind(name));

    async function load() {
      try {
        const { blob, contentType } = await getFileContent();

        if (cancelled) return;

        const previewType = getFilePreviewKind(name, contentType || blob.type);
  setResolvedFileType(previewType);

        if (previewType === "text" || previewType === "markdown") {
          const text = await blob.text();
          if (!cancelled) setContent(text);
        } else if (previewType === "html") {
          // Sanitised text in a srcdoc frame, like the .eml preview; never a
          // blob: URL of the sender's bytes (see htmlAttachmentDocument).
          const text = await blob.text();
          if (!cancelled) setHtmlDoc(htmlAttachmentDocument(text, blockRemote));
        } else if (previewType === "eml") {
          // Parse the embedded message (postal-mime, dynamic-imported so it
          // stays off the bundle) and render it like an email via EmlPreview.
          const { default: PostalMime } = await import("postal-mime");
          const parsed = await new PostalMime().parse(await blob.arrayBuffer());
          if (!cancelled) setEmlContent(parsed as ParsedEml);
        } else {
          // Re-type the blob to one its viewer can show; a blob: URL with a
          // type the browser cannot display is silently downloaded instead.
          const effectiveType = previewBlobType(name, contentType, blob.type);
          const typedBlob = blob.type !== effectiveType
            ? new Blob([blob], { type: effectiveType })
            : blob;
          // "Open image in new tab" loads the <img> URL as a document of its
          // own, so an image gets one that stays inert there: a sender's SVG
          // must not run script as the webmail origin (GHSA-xvjh-v9c6-qcvc).
          const url = previewType === "image"
            ? await imageBlobUrl(typedBlob)
            : URL.createObjectURL(typedBlob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          revokeUrl = url;
          setObjectUrl(url);
          setCanOpenInNewTab(isMimeTypeSafeForInlinePreview(effectiveType));
          if (previewType === "pdf") setPdfBlob(typedBlob);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
      if (revokeUrl) {
        URL.revokeObjectURL(revokeUrl);
      }
    };
  }, [getFileContent, name, blockRemote]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [onClose]);

  return (
    <div role="dialog" aria-label={name} className="fixed inset-0 z-50 flex flex-col bg-black/80" onClick={onClose}>
      {/* The dialog is `fixed inset-0` under `viewport-fit=cover`, so in an
          installed iOS PWA (no browser chrome above it) the header would sit
          underneath the status bar and its buttons - including the close
          button - became unreachable (#936). Pad the bar itself so its
          background still bleeds behind the status bar / notch. The insets are
          physical, so pl/pr (not ps/pe) is correct in RTL too. */}
      <div className="flex items-center justify-between gap-2 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 bg-background/90 backdrop-blur border-b border-border" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-medium truncate">{name}</h3>
        <div className="flex items-center gap-2">
          {/* An installed app hands the new window to the system browser,
              which cannot load our blob: URL (#865): no dead button there. */}
          {objectUrl && canOpenInNewTab && canOpenUrlInNewWindow(objectUrl) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title={t("open_in_new_tab")}
              aria-label={t("open_in_new_tab")}
              onClick={() => window.open(objectUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="w-4 h-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void onDownload()}>
            <Download className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))]">
        {loading && (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin" />
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">{t("preview_error")}</p>
        )}

        {!loading && !error && (fileType === "text") && content !== null && (
          <pre
            className="bg-background rounded-lg p-6 max-w-4xl w-full max-h-full overflow-auto text-sm font-mono whitespace-pre-wrap break-words"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Xenaxio step 115: addresses in a text file are clickable. */}
            <LinkifiedText text={content} />
          </pre>
        )}

        {!loading && !error && fileType === "markdown" && content !== null && (
          <div
            className="bg-background rounded-lg p-6 max-w-4xl w-full max-h-full overflow-auto text-sm"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Xenaxio step 115: Markdown as GitHub shows it (links, task boxes, tables). */}
            <MarkdownView source={content} />
          </div>
        )}

        {!loading && !error && fileType === "eml" && emlContent && (
          <EmlPreview message={emlContent} />
        )}

        {!loading && !error && fileType === "image" && objectUrl && (
          <div className="absolute inset-0">
            <ZoomableImage src={objectUrl} alt={name} onBackgroundClick={onClose} />
          </div>
        )}

        {!loading && !error && fileType === "html" && htmlDoc && (
          <iframe
            srcDoc={htmlDoc}
            sandbox=""
            className="w-full max-w-5xl h-full rounded-lg bg-white"
            title={name}
            onClick={(e) => e.stopPropagation()}
          />
        )}

        {!loading && !error && fileType === "pdf" && objectUrl && pdfInlineSupported && (
          // <iframe> renders PDFs reliably across desktop Chromium, Firefox,
          // and Safari from a blob: URL. <object> was prone to falling back to
          // a silent download when the blob's Content-Type wasn't recognised.
          <iframe
            src={objectUrl}
            className="w-full max-w-5xl h-full rounded-lg bg-white"
            title={name}
            onClick={(e) => e.stopPropagation()}
          />
        )}

        {!loading && !error && fileType === "pdf" && objectUrl && pdfBlob && !pdfInlineSupported && (
          // Mobile browsers can't show a PDF inline in an <iframe> (Android: a
          // blank frame / silent download; iOS: only the first page), so render
          // it with pdf.js (canvas) instead. The header's open-in-new-tab /
          // download actions are the fallback if pdf.js can't render the doc.
          <div
            className="w-full max-w-3xl h-full overflow-auto rounded-lg bg-neutral-200 dark:bg-neutral-800 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <PdfMobileViewer url={objectUrl} blob={pdfBlob} />
          </div>
        )}

        {!loading && !error && fileType === "audio" && objectUrl && (
          <div className="bg-background rounded-lg p-8 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium mb-4 text-center">{name}</p>
            <audio controls className="w-full" src={objectUrl} />
          </div>
        )}

        {!loading && !error && fileType === "video" && objectUrl && (
          <video
            controls
            className="max-w-4xl max-h-full rounded-lg"
            src={objectUrl}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
      <FilePreviewPluginSection file={file} />
    </div>
  );
}
