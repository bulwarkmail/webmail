"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface LinkDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** `text` is what the link shows; empty means the address itself. */
  onSubmit: (link: { text: string; href: string }) => void;
  /** The selected text, or the link's own text when editing one. */
  defaultText: string;
  defaultHref: string;
  /** Offers "Remove link" when editing a link. */
  onRemove?: () => void;
}

/**
 * Insert link (compose-p2-7): "Text" and "Link", as Gmail and Outlook ask. The
 * selection fills Text; with nothing selected the text (or the address) goes
 * in as a new link.
 */
export function LinkDialog({ isOpen, onClose, onSubmit, defaultText, defaultHref, onRemove }: LinkDialogProps) {
  const t = useTranslations("email_composer.toolbar");
  const tCommon = useTranslations("common");
  const id = useId();
  const [text, setText] = useState(defaultText);
  const [href, setHref] = useState(defaultHref);
  const textRef = useRef<HTMLInputElement>(null);
  const hrefRef = useRef<HTMLInputElement>(null);
  // With text already there, the address is what is left to give.
  const firstField = defaultText ? hrefRef : textRef;

  useEffect(() => {
    if (!isOpen) return;
    setText(defaultText);
    setHref(defaultHref);
  }, [isOpen, defaultText, defaultHref]);

  const address = href.trim();
  const error = /\s/.test(address) ? t("link_invalid") : null;
  const canSubmit = address.length > 0 && !error;
  const errorId = `${id}-error`;

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!canSubmit) return;
    try {
      onSubmit({ text, href: address });
    } finally {
      onClose();
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={defaultHref ? t("edit_link") : t("insert_link")}
      showClose={false}
      initialFocus={firstField}
      onSubmit={submit}
      footer={
        <>
          {onRemove && (
            <Button
              type="button"
              variant="ghost"
              className="me-auto"
              onClick={() => {
                try {
                  onRemove();
                } finally {
                  onClose();
                }
              }}
            >
              {t("remove_link")}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" variant="default" disabled={!canSubmit}>
            {tCommon("save")}
          </Button>
        </>
      }
    >
      <div className="mt-4 space-y-3">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-text`} className="block text-sm font-medium text-foreground">{t("link_text")}</label>
          <Input id={`${id}-text`} ref={textRef} type="text" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-href`} className="block text-sm font-medium text-foreground">{t("link")}</label>
          <Input
            id={`${id}-href`}
            ref={hrefRef}
            type="text"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            placeholder={t("link_address")}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={error ? "border-destructive focus-visible:border-destructive" : undefined}
          />
          {error && (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
