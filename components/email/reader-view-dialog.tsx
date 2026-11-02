"use client";

import { useCallback, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Volume2 } from "@/components/icons";
import { useMailReading } from "@/hooks/use-mail-reading";
import { useReadAloud } from "@/hooks/use-read-aloud";
import { sanitizePlainTextRenderedHtml } from "@/lib/email-sanitization";
import { ReadAloudBar } from "./read-aloud-bar";
import { gateLinkClick } from "@/lib/plugin-hook-result";

interface ReaderViewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The subject, as the dialog's title. */
  title: string;
  /** Who sent it, under the title. */
  description?: string;
  /** The body as safe HTML from plain text (plainTextToSafeHtml). */
  html: string;
  /** The body's language, for screen readers and the speech voice. */
  lang?: string | null;
}

/**
 * Reader view: one message, large, in the app's font, text spacing, reading
 * width and colours instead of the sender's layout, with read aloud built in.
 * A proper dialog: the focus moves in and stays there, Escape closes it and
 * the focus goes back to where it was.
 */
export function ReaderViewDialog({ isOpen, onClose, title, description, html, lang }: ReaderViewDialogProps) {
  const t = useTranslations('email_viewer');
  const reading = useMailReading();
  const articleRef = useRef<HTMLDivElement>(null);
  const getRoot = useCallback(() => articleRef.current, []);
  const readAloud = useReadAloud({ getRoot, lang, resetKey: isOpen ? html : null });
  const body = useMemo(() => ({ __html: sanitizePlainTextRenderedHtml(html) }), [html]);

  const close = () => {
    readAloud.stop();
    onClose();
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={close}
      title={title}
      description={description}
      className="max-w-none h-full"
      bodyClassName="flex-1"
      testId="reader-view"
    >
      <div className="flex flex-col gap-4">
        {readAloud.supported && (
          readAloud.state === 'idle' ? (
            <div>
              <Button variant="outline" size="sm" onClick={readAloud.start}>
                <Volume2 className="w-4 h-4 me-1.5" aria-hidden="true" />
                {t('read_aloud')}
              </Button>
            </div>
          ) : (
            <ReadAloudBar
              state={readAloud.state}
              onPause={readAloud.pause}
              onResume={readAloud.resume}
              onStop={readAloud.stop}
              className="rounded-md border"
            />
          )
        )}
        <div
          ref={articleRef}
          lang={lang ?? undefined}
          dir="auto"
          className="text-foreground [&_a]:text-primary [&_a]:underline"
          style={{
            fontSize: reading.plainFontSize(18),
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            textAlign: 'start',
            ...(reading.comfortableWidth && { maxWidth: '80ch' }),
          }}
          data-testid="reader-view-body"
          // Links open through the plugins' link check, as in the message.
          onClick={gateLinkClick}
          onAuxClick={gateLinkClick}
          dangerouslySetInnerHTML={body}
        />
      </div>
    </Dialog>
  );
}
