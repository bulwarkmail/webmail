import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiFetch } from '@/lib/browser-navigation';
import type { UpdateStatus, UpdateSeverity } from '@/lib/version-check/types';

const POLL_INTERVAL_MS = 15 * 60 * 1000;

interface UpdateState {
  status: UpdateStatus | null;
  loading: boolean;
  lastFetchedAt: number | null;
  // Latest version the user has dismissed the amber banner for. A newer
  // release re-shows the banner. Persisted in localStorage.
  dismissedVersion: string | null;

  fetchStatus: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  dismiss: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

interface ApiResponse {
  status: UpdateStatus | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
}

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set, get) => ({
      status: null,
      loading: false,
      lastFetchedAt: null,
      dismissedVersion: null,

      fetchStatus: async () => {
        if (inFlight) return inFlight;
        set({ loading: true });
        inFlight = (async () => {
          try {
            const res = await apiFetch('/api/system/update-status');
            if (!res.ok) return;
            const body = (await res.json()) as ApiResponse;
            set({
              status: body.status,
              lastFetchedAt: Date.now(),
            });
          } catch {
            // Silent — banner just won't appear, no need to disrupt the UI.
          } finally {
            set({ loading: false });
            inFlight = null;
          }
        })();
        return inFlight;
      },

      startPolling: () => {
        if (pollTimer) return;
        void get().fetchStatus();
        pollTimer = setInterval(() => {
          void get().fetchStatus();
        }, POLL_INTERVAL_MS);
      },

      stopPolling: () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      },

      dismiss: () => {
        const { status } = get();
        const target = status?.latest ?? status?.current;
        if (!target) return;
        set({ dismissedVersion: target });
      },
    }),
    {
      name: 'bulwark-update-dismissed',
      // Only persist the dismissal — status is fetched fresh per session.
      partialize: (s) => ({ dismissedVersion: s.dismissedVersion }),
    },
  ),
);

// Selectors. Keep them outside the store creator so components subscribing
// to a single derived value don't re-render on unrelated state changes.

export type BannerVariant = 'amber' | 'red';

export interface BannerInfo {
  variant: BannerVariant;
  severity: UpdateSeverity;
  latest: string | null;
  url: string | null;
  advisory: string | null;
  dismissible: boolean;
}

export function selectBanner(s: UpdateState): BannerInfo | null {
  const st = s.status;
  if (!st || !st.updateAvailable) return null;
  if (st.severity === 'none' || st.severity === 'unknown') return null;

  if (st.severity === 'security') {
    return {
      variant: 'red',
      severity: 'security',
      latest: st.latest,
      url: st.url,
      advisory: st.advisory,
      dismissible: false,
    };
  }
  if (st.severity === 'deprecated') {
    return {
      variant: 'red',
      severity: 'deprecated',
      latest: st.latest,
      url: st.url,
      advisory: null,
      dismissible: false,
    };
  }
  // normal
  const target = st.latest ?? st.current;
  if (s.dismissedVersion === target) return null;
  return {
    variant: 'amber',
    severity: 'normal',
    latest: st.latest,
    url: st.url,
    advisory: null,
    dismissible: true,
  };
}

// Used by the admin shield to show a dot regardless of dismissal state. We
// always want admins to see that an update is needed, even if the amber
// banner has been dismissed.
export function selectHasUpdate(s: UpdateState): boolean {
  return !!s.status?.updateAvailable && s.status.severity !== 'unknown';
}
