"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { describeAccelerator, QUICK_COMPOSE_DEFAULT, readShortcutPress } from "@/lib/desktop/shortcut-keys";
import type { DesktopQuickComposeStatus } from "@/lib/desktop/types";
import { SettingItem, ToggleSwitch } from "./settings-section";

interface KeyboardMap {
  get: (code: string) => string | undefined;
}

/** What each key gives alone on this keyboard. Not every browser has it, so it can be null. */
async function readKeyboardMap(): Promise<KeyboardMap | null> {
  try {
    const keyboard = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<KeyboardMap> } }).keyboard;
    return (await keyboard?.getLayoutMap?.()) ?? null;
  } catch {
    return null;
  }
}

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
  const [refused, setRefused] = useState<"types-character" | "reserved" | null>(null);
  const keyboardMap = useRef<KeyboardMap | null>(null);
  const { shortcut, active, locked } = status;
  const keys = shortcut ? describeAccelerator(shortcut, platform) : "";

  useEffect(() => {
    if (!recording) return;
    let stale = false;
    void readKeyboardMap().then((map) => {
      if (!stale) keyboardMap.current = map;
    });
    return () => {
      stale = true;
    };
  }, [recording]);

  const stopRecording = () => {
    setRecording(false);
    setRefused(null);
  };

  const description = refused === "types-character" ? t("types_character")
    : refused === "reserved" ? t("reserved")
    : recording ? t("recording_hint")
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
            onBlur={stopRecording}
            onKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                stopRecording();
                return;
              }
              const result = readShortcutPress(event, platform, keyboardMap.current?.get(event.code));
              if ("accelerator" in result) {
                stopRecording();
                onChange(result.accelerator);
              } else if (result.refused !== "incomplete") {
                setRefused(result.refused);
              }
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
