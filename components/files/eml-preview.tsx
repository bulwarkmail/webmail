"use client";

import { useTranslations } from "next-intl";
import { Paperclip, Download } from "lucide-react";
import { sanitizeEmailHtmlForIframe } from "@/lib/email-sanitization";

// A parsed message/rfc822 (.eml), as produced by postal-mime. Only the fields
// this preview renders are typed.
export type ParsedEml = {
  subject?: string;
  from?: { name?: string; address?: string };
  to?: Array<{ name?: string; address?: string }>;
  date?: string;
  html?: string;
  text?: string;
  attachments?: Array<{ filename?: string; mimeType?: string; content?: ArrayBuffer | Uint8Array }>;
};

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
// origin. Parsing happens in the caller (FilePreviewModal); this is pure
// presentation.
export function EmlPreview({ message }: { message: ParsedEml }) {
  const t = useTranslations("email_viewer");

  const bodyDoc = message.html
    ? sanitizeEmailHtmlForIframe(message.html)
    : message.text
      ? `<pre style="white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;margin:0;padding:8px">${escapeHtml(message.text)}</pre>`
      : "";

  const downloadAttachment = (att: NonNullable<ParsedEml["attachments"]>[number]) => {
    if (!att.content) return;
    // content is a real ArrayBuffer/Uint8Array at runtime; cast for the strict
    // BlobPart lib type (Uint8Array<ArrayBufferLike> vs ArrayBuffer).
    const url = URL.createObjectURL(new Blob([att.content as BlobPart], { type: att.mimeType || "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = att.filename || "attachment";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
          <div><span className="font-medium text-foreground">{t("date")}: </span>{new Date(message.date).toLocaleString()}</div>
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
            {message.attachments.map((att, i) => (
              <button
                key={i}
                type="button"
                onClick={() => downloadAttachment(att)}
                title={t("download")}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm bg-muted text-foreground hover:bg-muted/70"
              >
                <Paperclip className="w-3 h-3 flex-shrink-0" />
                <span className="max-w-[200px] truncate">{att.filename || "attachment"}</span>
                <Download className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
