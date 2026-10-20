"use client";

// "Kurz" and "Mit KI antworten" on an open email (spec I3). They hand over to
// the assistant panel, which streams the summary or saves the reply draft.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FileText, PenLine } from "@/components/icons";
import { assistantAvailable, sendAssistantCommand } from "@/lib/xenaxio/assistant";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";

export function AssistantEmailButtons({ threadId, subject }: { threadId: string; subject?: string }) {
  const t = useXT();
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (XENAXIO_BFF) void assistantAvailable().then(setAvailable);
  }, []);
  if (!available) return null;
  return (
    <>
      <Button variant="ghost" size="sm" className="sm:flex sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0" title={t("assistant.summarize")} onClick={() => sendAssistantCommand({ action: "summarize", threadId, ...(subject ? { subject } : {}) })}>
        <FileText className="w-4 h-4" />
        <span className="hidden sm:inline text-sm">{t("assistant.summarize")}</span>
      </Button>
      <Button variant="ghost" size="sm" className="sm:flex sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0" title={t("assistant.reply")} onClick={() => sendAssistantCommand({ action: "reply" })}>
        <PenLine className="w-4 h-4" />
        <span className="hidden sm:inline text-sm">{t("assistant.reply")}</span>
      </Button>
    </>
  );
}
