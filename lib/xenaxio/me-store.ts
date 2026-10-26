// The signed-in user, company and domain as the platform reports them
// (/api/me), shared by the domain banner, the "Verwaltung" menu entry and the
// composer. Loaded once per page load and refreshed every few minutes, so the
// banner disappears by itself once the domain gets connected.
import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { type DismissableHint, type Me, xenaxio } from "@/lib/xenaxio/api";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";

const REFRESH_MS = 5 * 60_000;

interface MeState {
  me: Me | null;
  loadedAt: number;
  loading: boolean;
  load: () => Promise<void>;
  dismissHint: (hint: DismissableHint) => void;
}

export const useXenaxioMeStore = create<MeState>((set, get) => ({
  me: null,
  loadedAt: 0,
  loading: false,
  load: async () => {
    if (!XENAXIO_BFF || get().loading || Date.now() - get().loadedAt < REFRESH_MS) return;
    set({ loading: true });
    try {
      set({ me: await xenaxio.me(), loadedAt: Date.now() });
    } catch {
      // Not signed in or offline: the mail app handles that itself.
      set({ loadedAt: Date.now() });
    } finally {
      set({ loading: false });
    }
  },
  dismissHint: (hint) => {
    const me = get().me;
    if (me) set({ me: { ...me, dismissedHints: [...new Set([...(me.dismissedHints ?? []), hint])] } });
    // Offline or signed out: it shows again next time, nothing else breaks.
    void xenaxio.dismissHint(hint).catch(() => {});
  },
}));

/** Current user and domain (null until loaded or outside the xenaxio build). */
export function useXenaxioMe(): Me | null {
  const me = useXenaxioMeStore((s) => s.me);
  const load = useXenaxioMeStore((s) => s.load);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  return me;
}

/** The domain is known and not connected yet: mail cannot be sent or received. */
export function domainPending(me: Me | null): me is Me & { domain: { name: string; status: "pending" } } {
  return me?.domain?.status === "pending";
}

/**
 * A hint the user can close for good, remembered by the platform for the user
 * (every device and company address). `dismissed` is null until /api/me has
 * loaded, so the hint does not flash up before that.
 */
export function useXenaxioHint(hint: DismissableHint): { dismissed: boolean | null; dismiss: () => void } {
  const me = useXenaxioMe();
  const dismissHint = useXenaxioMeStore((s) => s.dismissHint);
  return {
    dismissed: me ? (me.dismissedHints ?? []).includes(hint) : null,
    dismiss: useCallback(() => dismissHint(hint), [dismissHint, hint]),
  };
}
