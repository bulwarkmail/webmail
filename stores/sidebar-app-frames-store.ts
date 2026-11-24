import { create } from 'zustand';

/** An inline sidebar app whose frame is alive in this tab. */
export interface LiveAppFrame {
  id: string;
  url: string;
  name: string;
}

/**
 * How many apps keep their frame while closed. A chat app's frame can hold
 * 100 MB or more, so the oldest one goes once more are opened.
 */
export const MAX_LIVE_APP_FRAMES = 3;

interface SidebarAppFramesState {
  /** Frames alive in this tab, least recently opened first. */
  frames: LiveAppFrame[];
  /** The page pane an app is shown in, if any: its frame is laid over this element. */
  shown: { appId: string; slot: HTMLElement } | null;
  /**
   * Opens an app's frame. With `keepOthers` off only this app's frame stays,
   * as before frames outlived their page.
   */
  open: (app: LiveAppFrame, keepOthers: boolean) => void;
  /** Closes an app's frame, unless the user keeps apps loaded. */
  close: (appId: string, keep: boolean) => void;
  show: (appId: string, slot: HTMLElement) => void;
  /** Takes the app off this slot; a newer slot's app stays shown. */
  hide: (slot: HTMLElement) => void;
  /** Drops the frames of apps that are gone or changed their address. */
  prune: (apps: readonly LiveAppFrame[]) => void;
}

export const useSidebarAppFramesStore = create<SidebarAppFramesState>()((set) => ({
  frames: [],
  shown: null,

  open: (app, keepOthers) =>
    set((s) => {
      const rest = keepOthers ? s.frames.filter((f) => f.id !== app.id) : [];
      const frames = [...rest, app].slice(-MAX_LIVE_APP_FRAMES);
      return { frames };
    }),

  close: (appId, keep) =>
    set((s) => {
      if (keep) return s;
      return { frames: s.frames.filter((f) => f.id !== appId) };
    }),

  show: (appId, slot) => set({ shown: { appId, slot } }),

  hide: (slot) => set((s) => (s.shown?.slot === slot ? { shown: null } : s)),

  prune: (apps) =>
    set((s) => {
      const frames = s.frames.filter((f) => apps.some((a) => a.id === f.id && a.url === f.url));
      if (frames.length === s.frames.length) return s;
      return { frames };
    }),
}));
