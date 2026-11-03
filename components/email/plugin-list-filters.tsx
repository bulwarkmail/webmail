"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { iconForName, X } from "@/components/icons";
import { cn } from "@/lib/utils";
import {
  activeListFilterCondition,
  activeListFilterKeys,
  listFilterApplies,
  listFilterRevision,
  listFilters,
  setListFilterActive,
  subscribeListFilters,
} from "@/lib/plugin-sandbox/list-filters";
import type { MailAccountKind } from "@/lib/plugin-sandbox/account-kind";

const NONE = new Set<string>();

/** Whether a plugin's filter is narrowing this folder's list right now. */
export function useFolderListFiltered(mailboxRole: string | null, accountKind: MailAccountKind | null): boolean {
  return useSyncExternalStore(
    subscribeListFilters,
    () => activeListFilterCondition({ role: mailboxRole, accountKind }) !== null,
    () => false,
  );
}

/**
 * The keyword filters plugins offer for this folder (api.ui.setListFilters),
 * as chips in the list header. A chip turns its filter on; an active chip
 * is pressed, shows a cross and turns it off again. `onChange` loads the list again
 * whenever the applied filters change, also when a plugin drops one that
 * was on.
 */
export function PluginListFilters({
  mailboxRole,
  accountKind,
  onChange,
  className,
}: {
  mailboxRole: string | null;
  accountKind: MailAccountKind | null;
  onChange: () => void;
  className?: string;
}) {
  const t = useTranslations("plugin_list");
  const filters = useSyncExternalStore(subscribeListFilters, listFilters, listFilters);
  const active = useSyncExternalStore(subscribeListFilters, activeListFilterKeys, () => NONE);
  const revision = useSyncExternalStore(subscribeListFilters, listFilterRevision, listFilterRevision);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    onChangeRef.current();
  }, [revision]);

  const shown = filters.filter((f) => listFilterApplies(f, { role: mailboxRole, accountKind }));
  if (shown.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("filters")}
      data-testid="plugin-list-filters"
      className={cn("px-4 py-1.5 border-b border-border flex items-center gap-2 flex-wrap", className)}
    >
      {shown.map((filter) => {
        const on = active.has(filter.key);
        const Icon = iconForName(filter.icon);
        return (
          <button
            key={filter.key}
            type="button"
            aria-pressed={on}
            // The name stays the filter's label; aria-pressed says it is on,
            // and the tooltip says a click removes it.
            title={on ? t("remove_filter", { label: filter.label }) : filter.pluginName}
            data-plugin-list-filter={filter.key}
            onClick={() => setListFilterActive(filter.key)}
            className={cn(
              "inline-flex items-center gap-1 h-7 max-w-[12rem] px-2.5 rounded-full text-xs border transition-colors",
              "focus-visible:outline-hidden",
              on
                ? "bg-primary/10 text-primary border-primary/30 hover:bg-primary/15"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {Icon && <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />}
            <span className="truncate font-medium">{filter.label}</span>
            {on && <X className="w-3 h-3 flex-shrink-0" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
