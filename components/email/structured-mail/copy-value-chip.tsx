"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy } from "@/components/icons";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";
import { CHIP_BOX_CLASS, CHIP_ICON_CLASS } from "../attachment-chips";

interface CopyValueChipProps {
  /** What a click copies: a booking reference, order or tracking number. */
  value: string;
  /** The button's accessible name, naming what is copied ("Copy booking reference QX7K2M"). */
  copyLabel: string;
  /** The toast after copying ("Booking reference copied"). */
  copiedMessage: string;
  /** A visible label in front of the value ("Booking reference"). */
  label?: string;
  className?: string;
}

/** A number from a booking or parcel card; a click copies it. Looks like the verification code chip. */
export function CopyValueChip({ value, copyLabel, copiedMessage, label, className }: CopyValueChipProps) {
  const t = useTranslations("email_viewer.structured_mail");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(copiedMessage);
    } catch {
      toast.error(t("copy_failed"));
    }
  };

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void copy(); }}
      title={copyLabel}
      aria-label={copyLabel}
      data-testid="copy-value-chip"
      className={cn(CHIP_BOX_CLASS, "max-w-full bg-background/60 font-medium text-foreground hover:bg-muted transition-colors", className)}
    >
      <Icon aria-hidden="true" className={cn(CHIP_ICON_CLASS, copied ? "text-success" : "text-muted-foreground")} />
      {label && <span className="font-normal text-muted-foreground">{label}</span>}
      {/* Digit groups keep their order in a right-to-left UI. */}
      <bdi dir="ltr" className="min-w-0 break-all font-mono tracking-wide">{value}</bdi>
    </button>
  );
}
