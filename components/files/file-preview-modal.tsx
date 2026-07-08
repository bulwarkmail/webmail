"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { X, Download, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getFilePreviewKind, isMimeTypeSafeForInlinePreview } from "@/lib/file-preview";
import dynamic from "next/dynamic";
import { EmlPreview, type ParsedEml } from "@/components/files/eml-preview";

// pdf.js-based inline viewer for mobile (no native inline PDF viewer). Loaded
// only on the mobile PDF path so pdfjs-dist + its worker never reach the
// desktop bundle.
const PdfMobileViewer = dynamic(
  () => import("@/components/files/pdf-mobile-viewer").then((m) => m.PdfMobileViewer),
  { ssr: false },
);

// Map a few well-known extensions back to canonical MIME types. Used when the
// server returns application/octet-stream (or empty) for an attachment whose
// actual type is obvious from the filename. The blob.type drives how browsers
// render blob: URLs, so guessing wrong here means the inline preview silently
// downgrades to a download.
const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
};

function inferMimeFromName(name: string): string | undefined {
  const ext = name.toLowerCase().split(".").pop();
  return ext ? EXT_TO_MIME[ext] : undefined;
}

interface FilePreviewModalProps {
  name: string;
  onClose: () => void;
  onDownload: () => Promise<void> | void;
  getFileContent: () => Promise<{ blob: Blob; contentType: string }>;
}

function SimpleMarkdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headers
    if (line.startsWith("### ")) {
      elements.push(<h3 key={i} className="text-lg font-semibold mt-4 mb-2">{processInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} className="text-xl font-semibold mt-5 mb-2">{processInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={i} className="text-2xl font-bold mt-6 mb-3">{processInline(line.slice(2))}</h1>);
    } else if (line.startsWith("---") || line.startsWith("***")) {
      elements.push(<hr key={i} className="my-4 border-border" />);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(<li key={i} className="ms-4 list-disc">{processInline(line.slice(2))}</li>);
    } else if (/^\d+\. /.test(line)) {
      elements.push(<li key={i} className="ms-4 list-decimal">{processInline(line.replace(/^\d+\. /, ""))}</li>);
    } else if (line.startsWith("> ")) {
      elements.push(<blockquote key={i} className="border-s-4 border-border ps-4 italic text-muted-foreground my-2">{processInline(line.slice(2))}</blockquote>);
    } else if (line.startsWith("```")) {
      // Code block - collect until closing ```
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={i} className="bg-muted rounded p-3 my-2 overflow-x-auto text-sm font-mono">
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
    } else if (line.trim() === "") {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(<p key={i} className="my-1">{processInline(line)}</p>);
    }
  }

  return <div className="prose prose-sm dark:prose-invert max-w-none">{elements}</div>;
}

function processInline(text: string): React.ReactNode {
  // Process bold, italic, code inline
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Inline code
    const codeMatch = remaining.match(/`([^`]+)`/);
    // Italic
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);

    const matches = [
      boldMatch && { type: "bold", match: boldMatch },
      codeMatch && { type: "code", match: codeMatch },
      italicMatch && { type: "italic", match: italicMatch },
    ].filter(Boolean).sort((a, b) => (a!.match.index ?? 0) - (b!.match.index ?? 0));

    if (matches.length === 0) {
      parts.push(remaining);
      break;
    }

    const first = matches[0]!;
    const idx = first.match.index ?? 0;

    if (idx > 0) {
      parts.push(remaining.slice(0, idx));
    }

    if (first.type === "bold") {
      parts.push(<strong key={key++}>{first.match[1]}</strong>);
    } else if (first.type === "code") {
      parts.push(<code key={key++} className="bg-muted px-1 py-0.5 rounded text-sm font-mono">{first.match[1]}</code>);
    } else {
      parts.push(<em key={key++}>{first.match[1]}</em>);
    }

    remaining = remaining.slice(idx + first.match[0].length);
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

export function FilePreviewModal({ name, onClose, onDownload, getFileContent }: FilePreviewModalProps) {
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

  // Make the Android/browser Back button close the preview instead of
  // navigating the page underneath: push a throwaway history entry when the
  // modal opens and close it on popstate. On a normal close (X / backdrop /
  // Escape) the modal unmounts and we pop that entry ourselves, so the user's
  // next Back isn't swallowed by it.
  useEffect(() => {
    window.history.pushState({ __filePreview: true }, "");
    let poppedByBack = false;
    const onPop = () => {
      poppedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!poppedByBack) window.history.back();
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
        } else if (previewType === "eml") {
          // Parse the embedded message (postal-mime, dynamic-imported so it
          // stays off the bundle) and render it like an email via EmlPreview.
          const { default: PostalMime } = await import("postal-mime");
          const parsed = await new PostalMime().parse(await blob.arrayBuffer());
          if (!cancelled) setEmlContent(parsed as ParsedEml);
        } else {
          // Stalwart's download endpoint can return generic
          // application/octet-stream for attachments even when the email's
          // MIME structure declared application/pdf (etc.). The blob inherits
          // that, so a blob: URL plugged into <iframe> looks like a binary
          // stream and Chrome/Edge silently download it (with the blob UUID
          // as filename) instead of rendering inline. Re-wrap with the most
          // specific MIME we can resolve - prefer explicit attachment type,
          // then filename-derived MIME, then whatever the blob came with.
          const inferredFromName = inferMimeFromName(name);
          const isUseless = (ty?: string) =>
            !ty || ty === "application/octet-stream" || ty === "binary/octet-stream";
          const effectiveType =
            (contentType && !isUseless(contentType) ? contentType : undefined)
            ?? inferredFromName
            ?? blob.type;
          const typedBlob = blob.type !== effectiveType
            ? new Blob([blob], { type: effectiveType })
            : blob;
          revokeUrl = URL.createObjectURL(typedBlob);
          if (!cancelled) {
            setObjectUrl(revokeUrl);
            setCanOpenInNewTab(isMimeTypeSafeForInlinePreview(effectiveType));
          }
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
  }, [getFileContent, name]);

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
      <div className="flex items-center justify-between px-4 py-3 bg-background/90 backdrop-blur border-b border-border" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-medium truncate">{name}</h3>
        <div className="flex items-center gap-2">
          {objectUrl && canOpenInNewTab && (
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

      <div className="flex-1 flex items-center justify-center overflow-auto p-4">
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
            {content}
          </pre>
        )}

        {!loading && !error && fileType === "markdown" && content !== null && (
          <div
            className="bg-background rounded-lg p-6 max-w-4xl w-full max-h-full overflow-auto text-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <SimpleMarkdown content={content} />
          </div>
        )}

        {!loading && !error && fileType === "eml" && emlContent && (
          <EmlPreview message={emlContent} />
        )}

        {!loading && !error && fileType === "image" && objectUrl && (
          <img
            src={objectUrl}
            alt={name}
            className="max-w-full max-h-full object-contain rounded-lg bg-background"
            draggable={false}
            onClick={(e) => e.stopPropagation()}
          />
        )}

        {!loading && !error && fileType === "html" && objectUrl && (
          <iframe
            src={objectUrl}
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

        {!loading && !error && fileType === "pdf" && objectUrl && !pdfInlineSupported && (
          // Mobile browsers can't show a PDF inline in an <iframe> (Android: a
          // blank frame / silent download; iOS: only the first page), so render
          // it with pdf.js (canvas) instead. The header's open-in-new-tab /
          // download actions are the fallback if pdf.js can't render the doc.
          <div
            className="w-full max-w-3xl h-full overflow-auto rounded-lg bg-neutral-200 dark:bg-neutral-800 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <PdfMobileViewer url={objectUrl} />
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
    </div>
  );
}
