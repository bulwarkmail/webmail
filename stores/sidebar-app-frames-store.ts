import { create } from 'zustand';

/** An inline sidebar app whose frame is alive in this tab. */
export interface LiveAppFrame {
  id: string;
  /** The app's own address, as the rail gives it. */
  url: string;
  name: string;
  /** Where a link sent the frame (openAt), when not to `url`. */
  src?: string;
  /**
   * Bumped each time a link opens the app: the frame goes to `src` again even
   * when that is the address it was given before, the app having moved on
   * inside since.
   */
  visit?: number;
}

/** A page mounted that can show an app: a link to an app opens in the newest. */
export interface AppHost {
  id: number;
  /** Shows the app in this page's pane, its frame as the store has it. */
  show: (app: LiveAppFrame) => void;
}

/** What an app last said about itself through `bulwark:app-badge`. */
export interface AppBadge {
  /** Unread items, in the app's own unit. */
  count: number;
  /** Items that need the user. Absent when the app doesn't tell them apart. */
  mentions?: number;
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
  badges: Record<string, AppBadge>;
  /**
   * Opens an app's frame. With `keepOthers` off only this app's frame stays,
   * as before frames outlived their page.
   */
  open: (app: LiveAppFrame, keepOthers: boolean) => void;
  /**
   * A link to the app: its frame - made now, or the one kept loaded - goes to
   * `src`, as `open` otherwise.
   */
  openAt: (app: LiveAppFrame, src: string, keepOthers: boolean) => LiveAppFrame;
  /** The pages mounted that can show an app (not embedded in another), the newest last. */
  hosts: AppHost[];
  addHost: (host: AppHost) => void;
  removeHost: (id: number) => void;
  /** Closes an app's frame, unless the user keeps apps loaded. */
  close: (appId: string, keep: boolean) => void;
  show: (appId: string, slot: HTMLElement) => void;
  /** Takes the app off this slot; a newer slot's app stays shown. */
  hide: (slot: HTMLElement) => void;
  /** Drops the frames of apps that are gone or changed their address. */
  prune: (apps: readonly LiveAppFrame[]) => void;
  setBadge: (appId: string, badge: AppBadge | null) => void;
}

function withoutBadges(badges: Record<string, AppBadge>, keep: readonly LiveAppFrame[]) {
  const ids = new Set(keep.map((f) => f.id));
  const out: Record<string, AppBadge> = {};
  for (const [id, badge] of Object.entries(badges)) if (ids.has(id)) out[id] = badge;
  return out;
}

export const useSidebarAppFramesStore = create<SidebarAppFramesState>()((set) => ({
  frames: [],
  shown: null,
  badges: {},
  hosts: [],

  open: (app, keepOthers) =>
    set((s) => {
      const rest = keepOthers ? s.frames.filter((f) => f.id !== app.id) : [];
      // The frame kept for the app stays as it is: one a link sent elsewhere
      // keeps that address rather than going back to the app's start.
      const kept = s.frames.find((f) => f.id === app.id && f.url === app.url);
      const frames = [...rest, kept ?? app].slice(-MAX_LIVE_APP_FRAMES);
      return { frames, badges: withoutBadges(s.badges, frames) };
    }),

  openAt: (app, src, keepOthers) => {
    let visited: LiveAppFrame = app;
    set((s) => {
      const kept = s.frames.find((f) => f.id === app.id && f.url === app.url);
      // The visit counted past whatever the kept frame was given last.
      visited = { ...(kept ?? app), src, visit: (kept?.visit ?? 0) + 1 };
      const rest = keepOthers ? s.frames.filter((f) => f.id !== app.id) : [];
      const frames = [...rest, visited].slice(-MAX_LIVE_APP_FRAMES);
      return { frames, badges: withoutBadges(s.badges, frames) };
    });
    return visited;
  },

  addHost: (host) => set((s) => ({ hosts: [...s.hosts.filter((h) => h.id !== host.id), host] })),

  removeHost: (id) => set((s) => ({ hosts: s.hosts.filter((h) => h.id !== id) })),

  close: (appId, keep) =>
    set((s) => {
      if (keep) return s;
      const frames = s.frames.filter((f) => f.id !== appId);
      return { frames, badges: withoutBadges(s.badges, frames) };
    }),

  show: (appId, slot) => set({ shown: { appId, slot } }),

  hide: (slot) => set((s) => (s.shown?.slot === slot ? { shown: null } : s)),

  prune: (apps) =>
    set((s) => {
      const frames = s.frames.filter((f) => apps.some((a) => a.id === f.id && a.url === f.url));
      if (frames.length === s.frames.length) return s;
      return { frames, badges: withoutBadges(s.badges, frames) };
    }),

  setBadge: (appId, badge) =>
    set((s) => {
      if (!s.frames.some((f) => f.id === appId)) return s;
      const badges = { ...s.badges };
      if (badge) badges[appId] = badge;
      else delete badges[appId];
      return { badges };
    }),
}));

/** Upper bound for a reported number, as in the protocol. */
const MAX_BADGE_NUMBER = 99_999;

function badgeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_BADGE_NUMBER
    ? value
    : null;
}

/**
 * Reads a `bulwark:app-badge` message:
 * `{ type: "bulwark:app-badge", version: 1, count, mentions?, state? }`.
 * Returns the badge, `null` to clear it (a `state` other than "ok"), or
 * `undefined` when the message isn't one.
 */
export function parseAppBadgeMessage(data: unknown): AppBadge | null | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'bulwark:app-badge' || msg.version !== 1) return undefined;
  if (msg.state !== undefined && msg.state !== 'ok') {
    return typeof msg.state === 'string' ? null : undefined;
  }
  const count = badgeNumber(msg.count);
  if (count === null) return undefined;
  if (msg.mentions === undefined) return { count };
  const mentions = badgeNumber(msg.mentions);
  return mentions === null ? undefined : { count, mentions };
}

/**
 * How a badge shows on the rail: a number, or only a dot for unread items
 * when the app counts mentions separately and has none.
 */
export function appBadgeMark(badge: AppBadge | undefined): { number: number } | { dot: true } | null {
  if (!badge) return null;
  if (badge.mentions !== undefined) {
    if (badge.mentions > 0) return { number: badge.mentions };
    return badge.count > 0 ? { dot: true } : null;
  }
  return badge.count > 0 ? { number: badge.count } : null;
}
