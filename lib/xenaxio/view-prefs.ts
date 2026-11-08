// xenaxio (step 125): how a person last viewed a board or list of projects and object types
// (board or list, sub-projects, swimlanes, grouping, filters, open chart, ...). Kept in the
// settings document the platform stores (step 64), so every device shows the same view.
import { useCallback, useMemo } from "react";
import { useSettingsStore } from "@/stores/settings-store";

/** Places remembered per person; the ones used longest ago go first. */
export const VIEW_PLACES_MAX = 500;

type Raw = Record<string, unknown>;

function readLegacy(key: string | undefined): Raw | undefined {
  if (!key || typeof window === "undefined") return undefined;
  try {
    const v = window.localStorage.getItem(key);
    if (v === null) return undefined;
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Raw) : { value: parsed };
  } catch {
    // Not JSON (an old plain value) or a private window.
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? undefined : { value: v };
    } catch {
      return undefined;
    }
  }
}

/** The views map with one place changed (moved to the end, the oldest dropped beyond the limit). */
export function withView(views: Record<string, Raw>, place: string, value: Raw): Record<string, Raw> {
  const next: Record<string, Raw> = {};
  for (const [k, v] of Object.entries(views)) if (k !== place) next[k] = v;
  next[place] = value;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - VIEW_PLACES_MAX))) delete next[k];
  return next;
}

/**
 * The person's view of one place. `parse` turns the stored object into valid values (unknown
 * or old values fall back to defaults); `legacyKey` is the browser key the view lived in before,
 * read once while nothing is stored on the platform yet.
 */
export function useViewPrefs<T extends Raw>(place: string, parse: (raw: Raw) => T, legacyKey?: string): [T, (change: Partial<T>) => void] {
  const stored = useSettingsStore((s) => s.xenaxioViews?.[place]);
  const raw = useMemo(() => stored ?? readLegacy(legacyKey) ?? {}, [stored, legacyKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- parse is a pure function of raw.
  const value = useMemo(() => parse(raw), [raw]);
  const update = useCallback(
    (change: Partial<T>) => {
      const state = useSettingsStore.getState();
      const views = state.xenaxioViews ?? {};
      const current = views[place] ?? raw;
      state.updateSetting("xenaxioViews", withView(views, place, { ...current, ...change }));
    },
    [place, raw],
  );
  return [value, update];
}
