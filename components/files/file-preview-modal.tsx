"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Printer } from "@/components/icons";
import { Spinner } from "@/components/ui/spinner";
import { PreviewShell, useBackdropClose, type PreviewNeighbours } from "@/components/files/preview-shell";
import { IconButton } from "@/components/ui/icon-button";
import { ZoomableImage } from "@/components/files/zoomable-image";
import { getFilePreviewKind, imageBlobUrl, isInlineSafeBlob, previewBlobType, toInertBlob } from "@/lib/file-preview";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { EmlPreview, type EmlAttachment, type ParsedEml } from "@/components/files/eml-preview";
import { FilePreviewPluginSection } from "@/components/files/file-preview-plugin-section";
import { canOpenUrlInNewWindow } from "@/lib/standalone-display";
import { saveBlobAs } from "@/lib/download-guard";
import { emailExportFilename } from "@/lib/download-filename";
import type { Email } from "@/lib/jmap/types";
import { noMediaSavingProps } from "@/lib/device-frame";
import { useDevicePolicy, useStrictestDevices } from "@/hooks/use-device-policy";
import { Watermark, useWatermarkText } from "@/components/device/watermark";
import { stripBidiControls } from "@/lib/bidi";
import { emailIframeCsp, sanitizeEmailBodyForIframe } from "@/lib/email-sanitization";
import { turnOffLinks, type LinksOffText } from "@/lib/phishing-links";
import { useSettingsStore } from "@/stores/settings-store";
import { useCloseOnBack } from "@/hooks/use-close-on-back";
import type { FileResourceView } from "@/lib/plugin-types";
import { useRemoteContentHeldBackAnywhere } from "@/hooks/use-third-party-mode";
import { printPdfUrl } from "@/lib/print-pdf";

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
export function htmlAttachmentDocument(html: string, blockRemote: boolean, linksOff?: LinksOffText): string {
  const clean = sanitizeEmailBodyForIframe(html, blockRemote).html;
  // An attachment of a message reported as phishing: its links are off too.
  const body = linksOff ? turnOffLinks(clean, linksOff) : clean;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${emailIframeCsp(blockRemote)}"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`;
}

// pdf.js-based inline viewer for mobile (no native inline PDF viewer). Loaded
// only on the mobile PDF path so pdfjs-dist + its worker never reach the
// desktop bundle.
const PdfMobileViewer = dynamic(
  () => import("@/components/files/pdf-mobile-viewer").then((m) => m.PdfMobileViewer),
  { ssr: false },
);

/**
 * A message attached without a file name gets one made up from its type or
 * the download fallback: "Email.eml", "attachment".
 */
function isUnnamedMessagePart(name: string): boolean {
  return /^(attachment|email|download)(\.eml)?$/i.test(name.trim());
}

interface FilePreviewModalProps {
  name: string;
  onClose: () => void;
  onDownload: () => Promise<void> | void;
  getFileContent: () => Promise<{ blob: Blob; contentType: string }>;
  /** The previewed file as plugins see it (file-preview-section). */
  file?: FileResourceView | null;
  /** The previous and next file of the folder, for ←/→. */
  neighbours?: PreviewNeighbours;
  /** The file is an attachment of a message reported as phishing: links in it are off. */
  linksOff?: boolean;
  /**
   * Whose device policy applies (Organisation > Devices): the signed-in
   * account the file or message belongs to. Left out: the strictest of the
   * accounts signed in here.
   */
  policyAccount?: string | { sourceClientAccountId?: string | null } | null;
  /**
   * What the app itself does with this kind of file, as a labelled button in
   * the header: "Import to a mail folder…" for a saved message, "Import into
   * contacts…" for a .csv (pim-p2-7).
   */
  extraAction?: { label: string; onClick: () => void };
  /**
   * Bring up the print dialog once the PDF is on screen: a plugin printing a
   * PDF it made (api.ui.print with `pdf`). Not while the organisation turns
   * printing off.
   */
  autoPrint?: boolean;
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

export function FilePreviewModal({ name, onClose, onDownload, getFileContent, file, neighbours, linksOff, policyAccount, extraAction, autoPrint }: FilePreviewModalProps) {
  const t = useTranslations("files");
  const tCommon = useTranslations("common");
  // No downloads: no download button, no new tab, no save from the
  // browser's own PDF viewer or media controls. No printing: the PDF goes
  // through pdf.js, which has no print button. The preview itself stays.
  const ownDevices = useDevicePolicy(policyAccount ?? undefined);
  const strictestDevices = useStrictestDevices();
  const devices = policyAccount === undefined ? strictestDevices : ownDevices;
  const downloadsOff = devices.noDownloads;
  const watermark = useWatermarkText(policyAccount ?? undefined, { strictest: policyAccount === undefined });
  const tPhishing = useTranslations("phishing_report");
  const linksOffText = useMemo<LinksOffText | undefined>(
    () => (linksOff ? { title: tPhishing("link_off"), note: tPhishing("link_off_note") } : undefined),
    [linksOff, tPhishing],
  );
  const [content, setContent] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [resolvedFileType, setResolvedFileType] = useState(() => getFilePreviewKind(name));
  const [pdfInlineSupported, setPdfInlineSupported] = useState(true);
  // The Blob behind objectUrl when it may open as a top-level navigation.
  // Blob URLs inherit our origin, so opening a script-bearing type
  // (text/html, image/svg+xml, ...) in a new tab would execute it in-origin;
  // only a Blob typed from the inline-safe list opens (isInlineSafeBlob).
  const [newTabBlob, setNewTabBlob] = useState<Blob | null>(null);
  const [emlContent, setEmlContent] = useState<ParsedEml | null>(null);
  const [emlBlob, setEmlBlob] = useState<Blob | null>(null);
  // The PDF blob itself, kept alongside its object URL: the pdf.js mobile
  // viewer needs the bytes, because fetching the blob: URL is blocked by CSP
  // connect-src (#871). The URL is still what the <iframe> and the
  // open-in-new-tab fallback use.
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [htmlDoc, setHtmlDoc] = useState<string | null>(null);
  // Always blocked with no third-party traffic (#903), while an
  // organisation locks "block" in any signed-in account (the attachment's
  // account isn't known here), and until the policy is known.
  const remoteBlockedByOrg = useRemoteContentHeldBackAnywhere();
  const blockRemote = useSettingsStore((state) => state.externalContentPolicy) !== "allow" || remoteBlockedByOrg;
  // An attachment of the previewed .eml, shown in a preview of its own in
  // place of this one. It holds a Back entry of its own, so Escape and Back
  // close it first and come back here.
  const [nestedPreview, setNestedPreview] = useState<{ name: string; blob: Blob } | null>(null);

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

  // Back closes the preview instead of leaving Files.
  useCloseOnBack({ onBack: onClose });
  const closeFromBackdrop = useBackdropClose(onClose);

  const fileType = resolvedFileType;
  // The browser's own PDF viewer has Download and Print buttons of its own.
  const pdfViaPdfJs = devices.noDownloads || devices.noPrint;
  // Print in the header too, the same in every browser and in the desktop
  // app: through the browser's PDF viewer, from a frame of its own. Not on
  // phones, which have no PDF viewer to print from, nor where the
  // organisation turns printing off.
  const canPrintPdf = fileType === "pdf" && pdfInlineSupported && !devices.noPrint;

  useEffect(() => {
    let cancelled = false;
    let revokeUrl: string | null = null;

    setContent(null);
    setObjectUrl(null);
    setNewTabBlob(null);
    setEmlContent(null);
    setEmlBlob(null);
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
          if (!cancelled) setHtmlDoc(htmlAttachmentDocument(text, blockRemote, linksOffText));
        } else if (previewType === "eml") {
          // Parse the embedded message (postal-mime, dynamic-imported so it
          // stays off the bundle) and render it like an email via EmlPreview.
          const { default: PostalMime } = await import("postal-mime");
          const parsed = await new PostalMime().parse(await blob.arrayBuffer());
          if (!cancelled) {
            setEmlContent(parsed as ParsedEml);
            setEmlBlob(blob);
          }
        } else {
          // Re-type the blob to one its viewer can show; a blob: URL with a
          // type the browser cannot display is silently downloaded instead.
          const effectiveType = previewBlobType(name, contentType, blob.type);
          const typedBlob = blob.type !== effectiveType
            ? new Blob([blob], { type: effectiveType })
            : blob;
          // What a blob: URL is made from: a type from the inline-safe list
          // or octet-stream, whatever the file declared.
          const urlBlob = toInertBlob(typedBlob);
          // "Open image in new tab" loads the <img> URL as a document of its
          // own, so an image gets one that stays inert there: a sender's SVG
          // must not run script as the webmail origin (GHSA-xvjh-v9c6-qcvc).
          const url = previewType === "image"
            ? await imageBlobUrl(typedBlob)
            : URL.createObjectURL(urlBlob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          revokeUrl = url;
          setObjectUrl(url);
          // imageBlobUrl() mints the same type as urlBlob, or a data: URL for SVG.
          setNewTabBlob(url.startsWith("blob:") && isInlineSafeBlob(urlBlob) ? urlBlob : null);
          if (previewType === "pdf") setPdfBlob(urlBlob);
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
  }, [getFileContent, name, blockRemote, linksOffText]);

  const openEmlAttachment = (att: EmlAttachment) => {
    if (!att.content) return;
    setNestedPreview({
      name: att.filename ? stripBidiControls(att.filename) : "attachment",
      // content is a real ArrayBuffer/Uint8Array at runtime; cast for the
      // strict BlobPart lib type, as EmlPreview's download does.
      blob: new Blob([att.content as BlobPart], { type: att.mimeType || "application/octet-stream" }),
    });
  };
  // Stable per attachment: the loader effect re-runs when it changes.
  const nestedContent = useMemo(
    () => nestedPreview
      ? async () => ({ blob: nestedPreview.blob, contentType: nestedPreview.blob.type })
      : null,
    [nestedPreview],
  );
  const downloadNested = () => {
    if (!nestedPreview) return;
    saveBlobAs(nestedPreview.blob, nestedPreview.name, { kind: "attachment", subject: policyAccount });
  };

  // A plugin's PDF to print: the dialog comes up once, when the file is here.
  const autoPrinted = useRef(false);
  useEffect(() => {
    if (!autoPrint || autoPrinted.current || loading || error || !objectUrl || !canPrintPdf) return;
    autoPrinted.current = true;
    void printPdfUrl(objectUrl);
  }, [autoPrint, loading, error, objectUrl, canPrintPdf]);

  // In place of this frame, not on top of it: one frame at a time takes
  // Escape and the arrows. This one keeps its state and its Back entry.
  if (nestedPreview && nestedContent) {
    return (
      <FilePreviewModal
        name={nestedPreview.name}
        onClose={() => setNestedPreview(null)}
        onDownload={downloadNested}
        getFileContent={nestedContent}
        linksOff={linksOff}
        policyAccount={policyAccount}
      />
    );
  }

  // An attached message that came without a file name of its own is called
  // by its subject, not "attachment", and saved under it.
  const emlSubject = fileType === "eml" && isUnnamedMessagePart(name) ? emlContent?.subject?.trim() || null : null;
  const download = () => {
    if (emlSubject && emlBlob) {
      const filename = emailExportFilename({ subject: emlSubject } as Email, { template: "{subject}" });
      saveBlobAs(emlBlob, filename, { kind: "attachment", subject: policyAccount });
      return;
    }
    void onDownload();
  };

  return (
    <PreviewShell
      name={emlSubject ?? name}
      onClose={onClose}
      onDownload={downloadsOff ? undefined : download}
      neighbours={neighbours}
      // An installed app hands the new window to the system browser, which
      // cannot load our blob: URL (#865): no dead button there.
      actions={(
        <>
          {extraAction && (
            <Button size="sm" variant="outline" className="me-1" data-testid="preview-extra-action" onClick={extraAction.onClick}>
              {extraAction.label}
            </Button>
          )}
          {objectUrl && canPrintPdf && !loading && !error && (
            <IconButton label={tCommon("print")} onClick={() => { void printPdfUrl(objectUrl); }} data-testid="preview-print">
              <Printer />
            </IconButton>
          )}
          {objectUrl && newTabBlob && isInlineSafeBlob(newTabBlob) && !downloadsOff && canOpenUrlInNewWindow(objectUrl) && (
            <IconButton label={t("open_in_new_tab")} onClick={() => { if (isInlineSafeBlob(newTabBlob)) window.open(objectUrl, "_blank", "noopener,noreferrer"); }}>
              <ExternalLink />
            </IconButton>
          )}
        </>
      )}
    >
      <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))]">
        {loading && <Spinner label={t("loading")} className="w-8 h-8 text-white/80" />}
        {!loading && !error && <Watermark text={watermark} />}

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
          <EmlPreview message={emlContent} onOpenAttachment={openEmlAttachment} linksOff={linksOff} downloadsOff={downloadsOff} />
        )}

        {!loading && !error && fileType === "image" && objectUrl && (
          <div className="absolute inset-0" {...noMediaSavingProps(downloadsOff)}>
            <ZoomableImage src={objectUrl} alt={name} onBackgroundClick={closeFromBackdrop} />
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

        {!loading && !error && fileType === "pdf" && objectUrl && pdfInlineSupported && !pdfViaPdfJs && (
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

        {!loading && !error && fileType === "pdf" && objectUrl && pdfBlob && (!pdfInlineSupported || pdfViaPdfJs) && (
          // Mobile browsers can't show a PDF inline in an <iframe> (Android: a
          // blank frame / silent download; iOS: only the first page), so render
          // it with pdf.js (canvas) instead. The header's open-in-new-tab /
          // download actions are the fallback if pdf.js can't render the doc.
          <div
            className="w-full max-w-3xl h-full overflow-auto rounded-lg bg-neutral-200 dark:bg-neutral-800 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <PdfMobileViewer url={objectUrl} blob={pdfBlob} allowNewTab={!downloadsOff} />
          </div>
        )}

        {!loading && !error && fileType === "audio" && objectUrl && (
          <div className="bg-background rounded-lg p-8 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium mb-4 text-center">{name}</p>
            <audio controls className="w-full" src={objectUrl} controlsList={downloadsOff ? "nodownload" : undefined} onContextMenu={downloadsOff ? (e) => e.preventDefault() : undefined} />
          </div>
        )}

        {!loading && !error && fileType === "video" && objectUrl && (
          <video
            controls
            controlsList={downloadsOff ? "nodownload" : undefined}
            disablePictureInPicture={downloadsOff || undefined}
            onContextMenu={downloadsOff ? (e) => e.preventDefault() : undefined}
            className="max-w-4xl max-h-full rounded-lg"
            src={objectUrl}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
      <FilePreviewPluginSection file={file} />
    </PreviewShell>
  );
}
