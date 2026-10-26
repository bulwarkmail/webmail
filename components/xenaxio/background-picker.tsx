"use client";

// Step 42: a grid of background previews, as in Outlook's "Appearance".
// Used by the person in Settings → Appearance and by the admin on
// "Erscheinungsbild" (the company's default).
import { useState } from "react";
import { Check } from "@/components/icons";
import { cn } from "@/lib/utils";
import { BACKGROUNDS, type Background, NO_BACKGROUND, effectiveBackground, findBackground } from "@/lib/xenaxio/backgrounds";
import { useXT } from "@/lib/xenaxio/i18n";
import { useXenaxioMe, useXenaxioMeStore } from "@/lib/xenaxio/me-store";
import { xenaxio } from "@/lib/xenaxio/api";
import { useThemeStore } from "@/stores/theme-store";
import { SettingsSection } from "@/components/settings/settings-section";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";

/** A choice in the grid: a background, "none", or (for a person) "as the company". */
type Choice = { code: string | null; label: string; bg: Background | null; caption?: boolean };

function Tile({ choice, selected, disabled, onSelect }: { choice: Choice; selected: boolean; disabled: boolean; onSelect: () => void }) {
  const dark = useThemeStore((s) => s.resolvedTheme === "dark");
  const preview = choice.bg ? (dark ? choice.bg.preview.dark : choice.bg.preview.light) : undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      title={choice.label}
      className={cn(
        "group relative aspect-video w-full overflow-hidden rounded-lg border text-xs transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        selected ? "border-primary ring-2 ring-primary" : "border-border hover:shadow-md",
      )}
      style={preview ? { background: preview } : undefined}
    >
      {!choice.bg && <span className="absolute inset-0 grid place-items-center bg-muted px-1 text-center text-muted-foreground">{choice.label}</span>}
      {choice.bg && (choice.caption ? (
        <span className="absolute inset-x-1 bottom-1 truncate rounded bg-background/85 px-1.5 py-0.5 text-start font-medium text-foreground">{choice.label}</span>
      ) : (
        <span className="sr-only">{choice.label}</span>
      ))}
      {selected && (
        <span className="absolute end-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground shadow">
          <Check className="h-3 w-3" />
        </span>
      )}
    </button>
  );
}

const GRID = "grid grid-cols-3 gap-2 sm:grid-cols-6";

export function BackgroundPicker({
  value,
  extra,
  disabled,
  onSelect,
}: {
  /** The saved code (null = the first extra choice). */
  value: string | null;
  /** Choices before the pictures: "as the company", "none". */
  extra: Choice[];
  disabled: boolean;
  onSelect: (code: string | null) => void;
}) {
  const t = useXT();
  const name = (bg: Background) => t(`background.names.${bg.name}`);
  const group = (kind: Background["kind"]) => BACKGROUNDS.filter((b) => b.kind === kind);
  return (
    <div className="space-y-4">
      <div className={GRID}>
        {extra.map((c) => (
          <Tile key={c.code ?? "follow"} choice={c} selected={c.code === value} disabled={disabled} onSelect={() => onSelect(c.code)} />
        ))}
      </div>
      {(["image", "gradient"] as const).map((kind) => (
        <div key={kind} className="space-y-2">
          <h3 className="text-sm font-medium">{t(kind === "image" ? "background.images" : "background.gradients")}</h3>
          <div className={GRID}>
            {group(kind).map((bg) => (
              <Tile key={bg.id} choice={{ code: bg.id, label: name(bg), bg }} selected={value === bg.id} disabled={disabled} onSelect={() => onSelect(bg.id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Settings → Appearance: the person's own background, saved on the platform (all devices). */
export function MyBackgroundSettings() {
  const t = useXT();
  const me = useXenaxioMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!me) return null;

  const company = findBackground(me.portal?.background);
  const own = me.background ?? null;
  const extra: Choice[] = [
    { code: null, label: company ? t("background.follow_named", { name: t(`background.names.${company.name}`) }) : t("background.follow"), bg: company, caption: true },
    { code: NO_BACKGROUND, label: t("background.none"), bg: null },
  ];
  const select = async (code: string | null) => {
    if (code === own) return;
    setBusy(true);
    setError(false);
    const before = useXenaxioMeStore.getState().me;
    // Shown at once; back to the old one if saving fails.
    if (before) useXenaxioMeStore.setState({ me: { ...before, background: code } });
    try {
      await xenaxio.setMyBackground(code);
    } catch {
      if (before) useXenaxioMeStore.setState({ me: before });
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const active = effectiveBackground(own, me.portal?.background);
  return (
    <div className="space-y-3 py-3">
      <p className="text-sm text-muted-foreground">{t("background.intro")}</p>
      <BackgroundPicker value={own === null || findBackground(own) || own === NO_BACKGROUND ? own : null} extra={extra} disabled={busy} onSelect={(c) => void select(c)} />
      {own === null && !active && <p className="text-xs text-muted-foreground">{t("background.follow_none")}</p>}
      {error && <p className="text-sm text-destructive" role="alert">{t("background.error")}</p>}
    </div>
  );
}

/** The section on Bulwark's Appearance page (xenaxio build only, once signed in). */
export function MyBackgroundSection() {
  // Checked before any hook: outside the xenaxio build this renders nothing and asks nothing.
  return XENAXIO_BFF ? <SignedInBackgroundSection /> : null;
}

function SignedInBackgroundSection() {
  const t = useXT();
  const me = useXenaxioMe();
  if (!me) return null;
  return (
    <SettingsSection id="background" title={t("background.title")}>
      <MyBackgroundSettings />
    </SettingsSection>
  );
}
