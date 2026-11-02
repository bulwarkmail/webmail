"use client";

import { useTranslations } from "next-intl";
import { Paperclip, Download } from "@/components/icons";
import { saveBlobAs } from "@/lib/download-guard";
import { emailIframeCsp, sanitizeEmailBodyForIframe } from "@/lib/email-sanitization";
import { turnOffLinks } from "@/lib/phishing-links";
import { getEffectiveTimeZone } from "@/lib/timezone";
import { stripBidiControls } from "@/lib/bidi";
import { isFilePreviewable } from "@/lib/file-preview";
import { useSettingsStore } from "@/stores/settings-store";
import { useRemoteContentHeldBackAnywhere } from "@/hooks/use-third-party-mode";

// A parsed message/rfc822 (.eml), as produced by postal-mime. Only the fields
// this preview renders are typed.
export type ParsedEml = {
  subject?: string;
  from?: { name?: string; address?: string };
  to?: Array<{ name?: string; address?: string }>;
  date?: string;
  html?: string;
  text?: string;
  attachments?: Array<EmlAttachment>;
};

export type EmlAttachment = { filename?: string; mimeType?: string; content?: ArrayBuffer | Uint8Array };

function formatAddress(a?: { name?: string; address?: string }): string {
  if (!a) return "";
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address || a.name || "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Renders a .eml attachment like an email: header (from/to/subject/date) + the
// body, plus the message's own attachments. The body is sanitized with
// DOMPurify AND rendered in a fully-locked sandbox iframe (sandbox="" - no
// scripts, no same-origin), so a script-bearing .eml can never execute in our
// origin. Remote content is blocked unless the user allows it everywhere:
// there is no per-message "load" here. Parsing happens in the caller
// (FilePreviewModal); this is pure presentation. An attachment the preview
// can show - often another message: a certified-mail (PEC) envelope wraps the
// original, and a forwarded PEC wraps that envelope - opens through
// onOpenAttachment, with download beside it.
export function EmlPreview({ message, onOpenAttachment, linksOff, downloadsOff = false }: {
  message: ParsedEml;
  onOpenAttachment?: (attachment: EmlAttachment) => void;
  /** Attached to a message reported as phishing: links are off. */
  linksOff?: boolean;
  /** A device policy turned downloads off: attachments only preview. */
  downloadsOff?: boolean;
}) {
  const t = useTranslations("email_viewer");
  const tPhishing = useTranslations("phishing_report");
  // Always blocked with no third-party traffic (#903), while an
  // organisation locks "block" in any signed-in account (the attachment's
  // account isn't known here), and until the policy is known.
  const remoteBlockedByOrg = useRemoteContentHeldBackAnywhere();
  const blockRemote = useSettingsStore((state) => state.externalContentPolicy) !== "allow" || remoteBlockedByOrg;
  const tFiles = useTranslations("files");

  // dir="auto" on a wrapper we control lets the first strong character pick
  // the direction, matching the main viewer.
  const body = message.html
    ? `<div dir="auto">${linksOff
      ? turnOffLinks(sanitizeEmailBodyForIframe(message.html, blockRemote).html, { title: tPhishing("link_off"), note: tPhishing("link_off_note") })
      : sanitizeEmailBodyForIframe(message.html, blockRemote).html}</div>`
    : message.text
      ? `<pre dir="auto" style="white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;margin:0;padding:8px">${escapeHtml(message.text)}</pre>`
      : "";
  // The strict CSP is the network backstop for whatever the DOM walk misses.
  const bodyDoc = body
    ? `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${emailIframeCsp(blockRemote)}"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`
    : "";

  const downloadAttachment = (att: EmlAttachment) => {
    if (!att.content) return;
    // content is a real ArrayBuffer/Uint8Array at runtime; cast for the strict
    // BlobPart lib type (Uint8Array<ArrayBufferLike> vs ArrayBuffer).
    saveBlobAs(new Blob([att.content as BlobPart], { type: att.mimeType || "application/octet-stream" }), att.filename || "attachment", { kind: "attachment" });
  };

  return (
    <div
      className="w-full max-w-3xl max-h-full self-start overflow-auto rounded-lg border border-border bg-background shadow-2xl p-4"
      onClick={(e) => e.stopPropagation()}
    >
      <h2 className="text-lg font-semibold text-foreground break-words">{message.subject || ""}</h2>
      <div className="mt-2 space-y-0.5 text-sm text-muted-foreground border-b border-border pb-3">
        {message.from && (
          <div><span className="font-medium text-foreground">{t("from")}: </span><bdi>{formatAddress(message.from)}</bdi></div>
        )}
        {message.to && message.to.length > 0 && (
          <div><span className="font-medium text-foreground">{t("to")}: </span><bdi>{message.to.map(formatAddress).join(", ")}</bdi></div>
        )}
        {message.date && (
          <div><span className="font-medium text-foreground">{t("date")}: </span>{new Date(message.date).toLocaleString(undefined, { timeZone: getEffectiveTimeZone() })}</div>
        )}
      </div>
      {bodyDoc && (
        <iframe
          title={message.subject || "email"}
          sandbox=""
          srcDoc={bodyDoc}
          className="w-full min-h-[55vh] mt-3 rounded bg-white"
        />
      )}
      {message.attachments && message.attachments.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="text-xs font-medium text-muted-foreground mb-2">{t("attachments")}</div>
          <div className="flex flex-wrap gap-2">
            {message.attachments.map((att, i) => {
              const name = att.filename ? stripBidiControls(att.filename) : "attachment";
              const opens = !!onOpenAttachment && !!att.content && isFilePreviewable(att.filename, att.mimeType);
              if (!opens && downloadsOff) {
                return (
                  <span key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm bg-muted text-muted-foreground">
                    <Paperclip className="w-3 h-3 flex-shrink-0" />
                    <span className="max-w-[200px] truncate">{name}</span>
                  </span>
                );
              }
              if (!opens) {
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => downloadAttachment(att)}
                    title={t("download")}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm bg-muted text-foreground hover:bg-muted/70"
                  >
                    <Paperclip className="w-3 h-3 flex-shrink-0" />
                    <span className="max-w-[200px] truncate">{name}</span>
                    <Download className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
                  </button>
                );
              }
              return (
                <div key={i} className="flex items-center rounded-md text-sm bg-muted text-foreground">
                  <button
                    type="button"
                    onClick={() => onOpenAttachment(att)}
                    title={tFiles("preview")}
                    className="flex items-center gap-2 ps-3 pe-2 py-1.5 rounded-s-md hover:bg-muted/70"
                  >
                    <Paperclip className="w-3 h-3 flex-shrink-0" />
                    <span className="max-w-[200px] truncate">{name}</span>
                  </button>
                  {!downloadsOff && (
                  <button
                    type="button"
                    onClick={() => downloadAttachment(att)}
                    title={t("download")}
                    aria-label={`${t("download")} ${name}`}
                    className="ps-1 pe-3 py-1.5 rounded-e-md hover:bg-muted/70"
                  >
                    <Download className="w-3 h-3 text-muted-foreground" />
                  </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
