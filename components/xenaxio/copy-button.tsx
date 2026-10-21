"use client";

import { useState } from "react";
import { Check, Copy } from "@/components/icons";
import { useXT } from "@/lib/xenaxio/i18n";

export function CopyButton({ value }: { value: string }) {
  const t = useXT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the value stays selectable on screen.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground shrink-0"
      aria-label={t("common.copy")}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
      <span>{copied ? t("common.copied") : t("common.copy")}</span>
    </button>
  );
}
