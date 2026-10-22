// The signed-in user, company and domain as the platform reports them
// (/api/me), shared by the domain banner, the "Verwaltung" menu entry and the
// composer. Loaded once per page load and refreshed every few minutes, so the
// banner disappears by itself once the domain gets connected.
import { useEffect } from "react";
import { create } from "zustand";
import { type Me, xenaxio } from "@/lib/xenaxio/api";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";

const REFRESH_MS = 5 * 60_000;

interface MeState {
  me: Me | null;
  loadedAt: number;
  loading: boolean;
  load: () => Promise<void>;
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
