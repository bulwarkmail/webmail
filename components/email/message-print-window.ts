import { emailIframeCsp, escapeHtml } from "@/lib/email-sanitization";
import { watermarkForPrint } from "@/lib/watermark";
import { activePrintTheme } from "@/lib/print/active-print-theme";
import { printPageMargin, printThemeVarsCss, readPrintThemeVars } from "@/lib/print/print-theme";
import { openPrintWindow, printPrintWindow } from "@/lib/desktop/print";
import type { MessagePrintFields } from "./message-print";

export interface MessagePrintWindowOptions {
  /** Remote content stays blocked: the window gets the reader's strict CSP. */
  externalBlocked: boolean;
  /** Organisation > Devices > Watermark, for this message's account. */
  watermark?: string | null;
  /** A window opened in the click that asked (the list's row menu); else one is opened here. */
  openedWindow?: Window;
  /** The reader's labels: From, To, Cc, Date, Attachments. */
  labels: { from: string; to: string; cc: string; date: string; attachments: string };
}

/**
 * Prints one message in a window of its own: the reader's Print action, and
 * Print in a conversation message's ⋮. Header (subject, from, to, cc, date,
 * attachments) and body, without the app around it.
 *
 * The theme's --print-* variables and the user's plugin print style (CSS
 * scoped to [data-print-theme], a letterhead) come along; with neither the
 * page is the one this action always printed.
 */
export function printMessageInWindow(fields: MessagePrintFields, options: MessagePrintWindowOptions): void {
  const { labels } = options;
  const printWatermark = options.watermark ? watermarkForPrint(options.watermark) : null;
  const date = fields.date;
  const toList = escapeHtml(fields.to);
  const ccList = escapeHtml(fields.cc);
  const attachmentList = escapeHtml(fields.attachments);
  const subjectText = fields.subject;
  const senderText = fields.sender;
  const plainBody = fields.plain;
  const printableBody = fields.bodyHtml;

  // What a theme and a plugin print style add; nothing when neither is set.
  const themeVars = readPrintThemeVars();
  const varsCss = printThemeVarsCss(themeVars);
  const printTheme = activePrintTheme();
  const pageMargin = printTheme?.pageMargin || printPageMargin(themeVars["--print-page-margin"]);
  const themeCss = [
    // A plugin style may set the variables in its own CSS (scoped to the body).
    varsCss || printTheme ? `${varsCss}
  body { font-family: var(--print-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif); color: var(--print-text-color, #000); }
  .header { border-bottom-color: var(--print-rule-color, #ccc); }
  .subject { font-family: var(--print-heading-font-family, var(--print-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)); color: var(--print-heading-color, var(--print-text-color, #000)); }` : '',
    pageMargin ? `@page { margin: ${pageMargin}; }` : '',
    printTheme ? `.pr-letterhead-header, .pr-letterhead-footer { white-space: pre-line; font-size: 12px; color: #555; }
  .pr-letterhead-header { margin-bottom: 16px; }
  .pr-letterhead-footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #e2e2e2; }` : '',
    printTheme?.css ?? '',
  ].filter(Boolean).join('\n');

  // In the desktop app a hidden window, shown in the app's own print preview.
  const printWindow = options.openedWindow ?? openPrintWindow();
  if (!printWindow) return;
  // A link in the message that navigates the popup itself (no target, a
  // non-web scheme) would hand the sender's page an opener to redirect
  // the webmail tab with. We write the document through our own handle.
  printWindow.opener = null;

  // The popup is an about:blank document of the app, so it carries the
  // app's CSP (img-src https:), not the message iframe's strict one. Add
  // the iframe's policy while remote content is blocked; it narrows the
  // inherited one.
  printWindow.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${emailIframeCsp(options.externalBlocked)}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(subjectText)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; color: #000; }
  .header { border-bottom: 1px solid #ccc; padding-bottom: 16px; margin-bottom: 16px; }
  .subject { font-size: 20px; font-weight: bold; margin-bottom: 12px; }
  .meta { font-size: 13px; color: #555; line-height: 1.6; }
  .meta strong { color: #000; }
  .body { font-size: 14px; line-height: 1.6; }
  /* Plain text keeps its line breaks, as in the reader. */
  .body.plain { white-space: pre-wrap; word-break: break-word; }
  .body.plain summary { display: none !important; }
  /* Only force the cap on images that set no width of their own: an
     !important 100% also overrides a sender's inline max-width, and an
     image sized by max-width + max-height + width:100% then grows to
     the pane width while its max-height still clamps the height - the
     picture renders stretched. Matches the viewer's own image rule.
     height stays !important so a fixed inline height cannot squash it. */
  .body img:not([style*="max-width"]) { max-width: 100% !important; }
  .body img[style*="max-width"] { max-width: 100%; }
  .body img { height: auto !important; }
  @media print { body { margin: 20px; } }
</style>${themeCss ? `<style data-print-theme-css>\n  ${themeCss}\n</style>` : ''}${printWatermark ? printWatermark.style : ''}</head><body dir="auto"${printTheme ? ` data-print-theme="${escapeHtml(printTheme.key)}"` : ''}>
${printWatermark ? printWatermark.html : ''}
${printTheme?.header ? `<div class="pr-letterhead-header" data-print-letterhead="header">${escapeHtml(printTheme.header)}</div>` : ''}
<div class="header pr-header">
  <div class="subject pr-title">${escapeHtml(subjectText)}</div>
  <div class="meta pr-message-meta">
    <div><strong>${escapeHtml(labels.from)}:</strong> ${escapeHtml(senderText)}</div>
    ${toList ? `<div><strong>${escapeHtml(labels.to)}:</strong> ${toList}</div>` : ''}
    ${ccList ? `<div><strong>${escapeHtml(labels.cc)}:</strong> ${ccList}</div>` : ''}
    ${date ? `<div><strong>${escapeHtml(labels.date)}:</strong> ${escapeHtml(date)}</div>` : ''}
    ${attachmentList ? `<div data-print-attachments><strong>${escapeHtml(labels.attachments)}:</strong> ${attachmentList}</div>` : ''}
  </div>
</div>
<div class="body pr-message-body${plainBody ? ' plain' : ''}">${printableBody}</div>
${printTheme?.footer ? `<div class="pr-letterhead-footer" data-print-letterhead="footer">${escapeHtml(printTheme.footer)}</div>` : ''}
</body></html>`);
  printWindow.document.close();
  void printPrintWindow(printWindow, subjectText);
}
