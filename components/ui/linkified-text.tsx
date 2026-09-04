"use client";

import { useMemo } from "react";
import { plainTextToSafeHtml, sanitizePlainTextRenderedHtml } from "@/lib/email-sanitization";

interface LinkifiedTextProps {
  /** Plain text, as stored on the object (no markup is interpreted). */
  text: string;
  className?: string;
}

/**
 * Plain text rendered with its http(s) URLs turned into real links.
 *
 * Meeting invitations carry the join URL in the event description (Teams,
 * Meet, Zoom and the iTIP fallbacks all do), so a text-only render leaves the
 * one actionable thing in the event un-clickable: the reader has to select the
 * URL by hand, and it usually wraps across lines.
 *
 * Same pipeline as a plain-text mail body: `plainTextToSafeHtml` escapes the
 * whole string and emits nothing but `<a href="http(s)://...">`, then
 * `sanitizePlainTextRenderedHtml` re-checks the result. That second pass is
 * defense in depth - unlike message bodies this renders into the main
 * document, not the sandboxed iframe.
 */
export function LinkifiedText({ text, className }: LinkifiedTextProps) {
  const html = useMemo(
    () => sanitizePlainTextRenderedHtml(plainTextToSafeHtml(text, "text-primary hover:underline")),
    [text],
  );

  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
