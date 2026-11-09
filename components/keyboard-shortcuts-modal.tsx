"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Keyboard } from "@/components/icons";
import { Dialog } from "@/components/ui/dialog";
import {
  SHORTCUT_APPS,
  sectionsWithGeneral,
  shortcutAppForPath,
  shortcutKeyFor,
  type ShortcutAppId,
  type ShortcutEntry,
  type ShortcutHost,
  type ShortcutSection,
} from "@/lib/keyboard-shortcuts";
import { isApplePlatform, shortcutAlternatives } from "@/lib/shortcut-keys";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { usePathname } from "@/i18n/navigation";
import { useTour } from "@/components/tour/tour-provider";
import { useProInterfaceActive } from "@/components/pro/pro-interface-redirect";
import { usePluginActions } from "@/components/plugins/plugin-actions";
import { usePolicyStore } from "@/stores/policy-store";

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The app to open on. Default: the app of the current page. */
  app?: ShortcutAppId;
}

/**
 * The keyboard shortcuts help (`?`): one tab per app that has keys, opened
 * on the current app's, each with the keys that work everywhere under
 * "Global".
 */
export function KeyboardShortcutsModal({ isOpen, onClose, app }: KeyboardShortcutsModalProps) {
  const t = useTranslations();
  const { startTour } = useTour();
  const pathname = usePathname();
  const tabsId = useId();
  // The focus starts on the list itself: on the first control it would
  // scroll to the tour link at the bottom when there are no tabs.
  const contentRef = useRef<HTMLDivElement>(null);
  const interfaceLayout = useSettingsStore((state) => state.interfaceLayout);
  const singleKeyShortcuts = useSettingsStore((state) => state.singleKeyShortcuts);
  const shell = useProInterfaceActive() ? "pro" : "standard";
  const features = usePolicyStore((s) => s.policy.features);
  // Plugin buttons in the composer that have a shortcut (composer-toolbar-actions).
  const pluginComposerShortcuts = usePluginActions("composer-toolbar-actions").filter((a) => a.shortcut);

  // Rows that belong to one interface layout (or one shell) are listed only under it,
  // and a row of a gated feature only while the admin has it on.
  const host = shortcutHost();
  const shown = (entries: readonly ShortcutEntry[]) =>
    entries.filter((entry) => shortcutKeyFor(entry, host) !== null
      && (!entry.layout || entry.layout === interfaceLayout)
      && (!entry.shell || entry.shell === shell)
      && (!entry.feature || (features[entry.feature] ?? true)));

  const apps = SHORTCUT_APPS.filter((a) => a.sections.some((s) => shown(s.entries).length > 0));
  const currentApp = app ?? shortcutAppForPath(pathname ?? "/");
  const initial = apps.some((a) => a.id === currentApp) ? currentApp : apps[0]?.id ?? "mail";
  const [selected, setSelected] = useState<ShortcutAppId>(initial);
  // Each time it opens, it opens on the current app.
  useEffect(() => {
    if (isOpen) setSelected(initial);
  }, [isOpen, initial]);

  const selectedApp = SHORTCUT_APPS.find((a) => a.id === selected);
  const sections = sectionsWithGeneral(selectedApp?.sections ?? []);

  const extraRows = (section: ShortcutSection) =>
    selected === "mail" && section.id === "composer"
      ? pluginComposerShortcuts.map((action) => (
          <ShortcutRow
            key={`${action.pluginId}:${action.id}`}
            shortcutKey={action.shortcut!}
            description={`${action.label} (${action.pluginName})`}
          />
        ))
      : null;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-3">
          <Keyboard className="w-5 h-5 text-muted-foreground" />
          {t("shortcuts.title")}
        </span>
      }
      initialFocus={contentRef}
    >
      <div ref={contentRef} tabIndex={-1} className="outline-none">
        {!singleKeyShortcuts && (
          <p className="mt-4 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground" data-testid="single-keys-off">
            {t("shortcuts.single_keys_off")}
          </p>
        )}
        {apps.length > 1 && (
          <div role="tablist" aria-label={t("shortcuts.title")} className="mt-4 flex flex-wrap gap-1 border-b border-border">
            {apps.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                id={`${tabsId}-${a.id}`}
                aria-selected={a.id === selected}
                aria-controls={`${tabsId}-panel`}
                onClick={() => setSelected(a.id)}
                className={cn(
                  "-mb-px px-3 py-2 text-sm border-b-2 transition-colors",
                  a.id === selected
                    ? "border-primary text-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t(a.title)}
              </button>
            ))}
          </div>
        )}

        <div
          id={`${tabsId}-panel`}
          role={apps.length > 1 ? "tabpanel" : undefined}
          aria-labelledby={apps.length > 1 ? `${tabsId}-${selected}` : undefined}
          className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-8"
        >
          {sections.map((section) => {
            const rows = shown(section.entries);
            const extra = extraRows(section);
            if (rows.length === 0 && !extra?.length) return null;
            return (
              <section key={section.id} className={cn(section.wide && "md:col-span-2")}>
                <h3 className="text-sm font-semibold text-foreground mb-3">
                  {t(section.title)}
                </h3>
                {/* A wide section's two columns line up with the columns of the
                    sections above it: the same 2rem gap as the panel grid. */}
                <div className={cn(section.wide ? "grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2" : "space-y-2")}>
                  {rows.map((shortcut) => (
                    <ShortcutRow
                      key={`${shortcut.key}:${shortcut.description}`}
                      shortcutKey={shortcutKeyFor(shortcut, host)!}
                      description={t(shortcut.description)}
                    />
                  ))}
                  {extra}
                </div>
              </section>
            );
          })}
        </div>

        {/* Footer tip */}
        <div className="mt-6 pt-4 border-t border-border">
          <p className="text-sm text-muted-foreground text-center">
            {singleKeyShortcuts ? t("shortcuts.tip") : t("shortcuts.tip_single_keys_off")}
          </p>
          <p className="text-sm text-center mt-2">
            <button
              type="button"
              onClick={() => { onClose(); startTour(); }}
              className="text-primary hover:text-primary/80 underline underline-offset-2 transition-colors"
            >
              {t("tour.take_a_tour")}
            </button>
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/** The desktop app has keys of its own (its menus), and they differ by system. */
function shortcutHost(): ShortcutHost {
  if (!getDesktopBridge()) return "browser";
  if (isApplePlatform()) return "mac";
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent) ? "windows" : "linux";
}

function ShortcutRow({
  shortcutKey,
  description,
}: {
  shortcutKey: string;
  description: string;
}) {
  const t = useTranslations("shortcuts");
  const keys = shortcutAlternatives(shortcutKey);

  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="min-w-0 text-sm text-muted-foreground">{description}</span>
      {/* The description wraps first. A key never breaks inside ("Shift + ↓"),
          and an alternative keeps its "or" with it ("n or c"); only a very
          long list wraps, between alternatives. */}
      <div className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 shrink-0 max-w-[75%]">
        {keys.map((key, index) => (
          <span key={index} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            {index > 0 && <span className="text-muted-foreground text-xs">{t("or")}</span>}
            <kbd
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap",
                "px-2 py-0.5 text-xs font-mono font-medium",
                "bg-muted border border-border rounded",
                "text-foreground shadow-sm",
                "min-w-[24px]"
              )}
            >
              {key}
            </kbd>
          </span>
        ))}
      </div>
    </div>
  );
}
