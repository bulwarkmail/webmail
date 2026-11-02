"use client";

// Once per checker plugin: what proofreading sends and where. Shown above
// the text the first time checking is on in a composer, also when the
// organisation turned it on (then worded as their choice). OK hides it for
// good on every device (the setting is synced).

import { useId } from "react";
import { useTranslations } from "next-intl";
import { SpellCheck } from "@/components/icons";
import { useSettingsStore } from "@/stores/settings-store";
import type { ProofreaderStatus } from "@/lib/proofreading/composer-proofreader";

export function ProofreadingNotice({ status }: { status: ProofreaderStatus }) {
  const t = useTranslations("proofreading");
  const textId = useId();
  const seen = useSettingsStore((s) => s.proofreadingNoticeSeen);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  if (!status.on) return null;
  const unseen = status.activePlugins.filter((p) => !seen[p.pluginId]);
  if (!unseen.length) return null;
  const names = new Intl.ListFormat(undefined, { type: "conjunction" }).format(status.activePlugins.map((p) => p.label));
  return (
    <div role="note" data-testid="proofreading-notice" className="mx-4 my-2 flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
      <SpellCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p id={textId} className="min-w-0 flex-1 text-muted-foreground">
        {t(status.forced ? "notice.forced" : "notice.on", { checkers: names })}
      </p>
      <button
        type="button"
        aria-describedby={textId}
        onClick={() => updateSetting("proofreadingNoticeSeen", { ...seen, ...Object.fromEntries(unseen.map((p) => [p.pluginId, true])) })}
        className="shrink-0 rounded-md px-2 py-0.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      >
        {t("notice.ok")}
      </button>
    </div>
  );
}
