"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { acceleratorFromKeyEvent, describeAccelerator, QUICK_COMPOSE_DEFAULT } from "@/lib/desktop/shortcut-keys";
import type { DesktopQuickComposeStatus } from "@/lib/desktop/types";
import { SettingItem, ToggleSwitch } from "./settings-section";

/**
 * The shortcut for a small composer window, on the desktop settings. What holds it is the
 * shell's business: this shows what it says, including that another app has the keys.
 */
export function DesktopQuickComposeSetting({ status, platform, onChange }: {
  status: DesktopQuickComposeStatus;
  platform: string | undefined;
  onChange: (shortcut: string | null) => void;
}) {
  const t = useTranslations("desktopQuickCompose");
  const [recording, setRecording] = useState(false);
  const { shortcut, active, locked } = status;
  const keys = shortcut ? describeAccelerator(shortcut, platform) : "";

  const description = recording ? t("recording_hint")
    : !shortcut ? t("description_off")
    : active ? t("description", { keys })
    : t("taken", { keys });

  return (
    <SettingItem label={t("label")} description={description} locked={locked}>
      <div className="flex items-center gap-2">
        {recording ? (
          <Button
            variant="outline"
            size="sm"
            autoFocus
            className="text-xs h-7"
            data-testid="quick-compose-recording"
            onBlur={() => setRecording(false)}
            onKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                setRecording(false);
                return;
              }
              const next = acceleratorFromKeyEvent(event, platform);
              if (!next) return;
              setRecording(false);
              onChange(next);
            }}
          >
            {t("recording")}
          </Button>
        ) : shortcut && (
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7"
            aria-label={t("change", { keys })}
            title={t("change", { keys })}
            data-testid="quick-compose-keys"
            onClick={() => setRecording(true)}
          >
            {keys}
          </Button>
        )}
        <ToggleSwitch checked={!!shortcut} onChange={(on) => onChange(on ? (status.builtIn ?? QUICK_COMPOSE_DEFAULT) : null)} />
      </div>
    </SettingItem>
  );
}
