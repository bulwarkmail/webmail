"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { pinLongEnough } from "@/lib/app-lock/crypto";

/** The new PIN, twice. Says what's wrong only once there's something to say. */
export function NewPinFields({ pin, repeat, onPin, onRepeat }: {
  pin: string;
  repeat: string;
  onPin: (value: string) => void;
  onRepeat: (value: string) => void;
}) {
  const t = useTranslations("appLock");
  const pinId = useId();
  const repeatId = useId();
  const hintId = useId();
  const tooShort = pin.length > 0 && !pinLongEnough(pin);
  const mismatch = repeat.length > 0 && repeat !== pin;
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={pinId} className="text-sm font-medium text-foreground">{t("pin_new")}</label>
        <Input
          id={pinId}
          data-testid="app-lock-new-pin"
          type="password"
          autoComplete="new-password"
          value={pin}
          onChange={(event) => onPin(event.target.value)}
          aria-describedby={hintId}
          aria-invalid={tooShort || undefined}
        />
        <p id={hintId} className="text-xs text-muted-foreground">{t("pin_hint")}</p>
      </div>
      <div className="space-y-1">
        <label htmlFor={repeatId} className="text-sm font-medium text-foreground">{t("pin_repeat")}</label>
        <Input
          id={repeatId}
          data-testid="app-lock-repeat-pin"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(event) => onRepeat(event.target.value)}
          aria-invalid={mismatch || undefined}
        />
        {mismatch && <p role="alert" className="text-xs text-destructive">{t("pin_mismatch")}</p>}
      </div>
    </div>
  );
}

export function newPinReady(pin: string, repeat: string): boolean {
  return pinLongEnough(pin) && pin === repeat;
}

/** A PIN already set, asked again before something that needs it. */
export function CurrentPinField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error?: string | null }) {
  const t = useTranslations("appLock");
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{t("pin_current")}</label>
      <Input
        id={id}
        data-testid="app-lock-current-pin"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
      />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
