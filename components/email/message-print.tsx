"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { PrintRoot } from "@/components/print/print-root";

export interface MessagePrintFields {
  subject: string;
  sender: string;
  to: string;
  cc: string;
  date: string;
  /** Sanitized body HTML without <style>: a re-sanitized HTML body, or the escaped plain-text one. */
  bodyHtml: string;
  plain: boolean;
}

// The reader's image rule: cap only images that set no max-width of their own.
const BODY_CSS = `
:host { display: block; font-size: 10.5pt; line-height: 1.5; overflow-wrap: break-word; }
img { height: auto !important; }
img:not([style*="max-width"]) { max-width: 100% !important; }
img[style*="max-width"] { max-width: 100%; }
table { max-width: 100%; }
* { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
.plain { white-space: pre-wrap; word-break: break-word; }
.plain summary { display: none !important; }
`;

/**
 * The open message as Ctrl+P prints it: header and body on white, with the
 * app around it (toolbar, list, plugin panels) left off the paper. The same
 * fields the reader's Print action puts in its window.
 *
 * The body goes into a shadow root: in the app's document it would get the
 * app's CSS reset (no paragraph margins, no table borders) and its classes.
 * It is filled in the commit, so it is there before the browser lays the
 * page out for printing.
 */
export function MessagePrint({ fields }: { fields: MessagePrintFields }) {
  const t = useTranslations("email_viewer");
  const meta: Array<[string, string]> = [
    [t("from"), fields.sender],
    [t("to"), fields.to],
    [t("cc"), fields.cc],
    [t("date"), fields.date],
  ];
  const { bodyHtml, plain } = fields;
  const fillBody = useCallback((host: HTMLDivElement | null) => {
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${BODY_CSS}</style><div dir="auto"${plain ? ' class="plain"' : ""}>${bodyHtml}</div>`;
  }, [bodyHtml, plain]);

  return (
    <PrintRoot orientation="portrait" title={fields.subject}>
      <article className="pr-message">
        <header className="pr-header">
          <h1 className="pr-title" dir="auto">{fields.subject}</h1>
          <dl className="pr-message-meta">
            {meta.filter(([, value]) => value).map(([label, value]) => (
              <div key={label}>
                <dt>{label}:</dt>
                <dd dir="auto">{value}</dd>
              </div>
            ))}
          </dl>
        </header>
        <div className="pr-message-body" data-message-print-body="" ref={fillBody} />
      </article>
    </PrintRoot>
  );
}
