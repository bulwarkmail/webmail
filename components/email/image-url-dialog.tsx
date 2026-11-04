"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Only a picture on the web: https, a host, and nothing that could run. */
export function pictureAddress(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A picture from a web address, for a signature (a logo). Signatures are capped at a
 * couple of kilobytes on the server, so the picture can't be uploaded into one: it stays
 * on the web and mail programs load it from there, as Gmail's signature editor does.
 */
export function ImageUrlDialog({ isOpen, onClose, onSubmit }: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (picture: { src: string; alt: string }) => void;
}) {
  const t = useTranslations("ux_p3_settings.picture");
  const tCommon = useTranslations("common");
  const id = useId();
  const [address, setAddress] = useState("");
  const [alt, setAlt] = useState("");
  const [touched, setTouched] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setAddress("");
    setAlt("");
    setTouched(false);
  }, [isOpen]);

  const src = pictureAddress(address);
  const error = touched && address.trim() && !src ? t("invalid") : null;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (!src) return;
    try {
      onSubmit({ src, alt: alt.trim() });
    } finally {
      onClose();
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("title")}
      showClose={false}
      initialFocus={addressRef}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" variant="default" disabled={!address.trim()}>
            {t("insert")}
          </Button>
        </>
      }
    >
      <div className="mt-4 space-y-3">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-src`} className="block text-sm font-medium text-foreground">{t("address")}</label>
          <Input
            id={`${id}-src`}
            ref={addressRef}
            type="text"
            inputMode="url"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="https://"
            aria-invalid={error ? true : undefined}
            aria-describedby={[error ? errorId : null, hintId].filter(Boolean).join(" ")}
            className={error ? "border-destructive focus-visible:border-destructive" : undefined}
          />
          <p id={hintId} className="text-xs text-muted-foreground">{t("address_hint")}</p>
          {error && (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-alt`} className="block text-sm font-medium text-foreground">{t("description")}</label>
          <Input id={`${id}-alt`} type="text" value={alt} onChange={(e) => setAlt(e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}
