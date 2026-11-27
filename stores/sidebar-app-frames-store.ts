import { create } from 'zustand';

/** An inline sidebar app whose frame is alive in this tab. */
export interface LiveAppFrame {
  id: string;
  url: string;
  name: string;
}

/**
 * What an app may say about its count (`state` of `bulwark:app-badge`):
 * - `ok`: the counts are current;
 * - `signed-out`: the user is signed out of the app;
 * - `offline`: the app lost its connection, the counts are its last;
 * - `unknown`: the app cannot count (it does not understand its own state).
 */
export const APP_BADGE_STATES = ['ok', 'signed-out', 'offline', 'unknown'] as const;
export type AppBadgeState = (typeof APP_BADGE_STATES)[number];

/**
 * What Bulwark knows of an app's count: the app's own state, or `silent`,
 * Bulwark's own finding that an app of the policy with `badge: true` said
 * nothing within `SILENT_MS` of its frame's making or load (the app
 * unreachable, the reporting part of it missing, the frame refused). Never
 * taken from a message.
 */
export type AppBadgeStatus = AppBadgeState | 'silent';
/** A state other than `ok`: the count cannot be trusted. */
export type AppBadgeTrouble = Exclude<AppBadgeStatus, 'ok'>;

/** How long after its frame's making or load an app with `badge: true` has to say something. */
export const SILENT_MS = 15_000;
/** How often a silent app's frame is loaded anew (and when the window has the focus again). */
export const SILENT_RELOAD_MS = 3 * 60_000;

/** What an app last said about itself through `bulwark:app-badge`. */
export interface AppBadge {
  /** Unread items, in the app's own unit. */
  count: number;
  /** Items that need the user. Absent when the app doesn't tell them apart. */
  mentions?: number;
  /** Absent while the counts are current (`ok`). */
  state?: AppBadgeTrouble;
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

  open: (app, keepOthers) =>
    set((s) => {
      const rest = keepOthers ? s.frames.filter((f) => f.id !== app.id) : [];
      const frames = [...rest, app].slice(-MAX_LIVE_APP_FRAMES);
      return { frames, badges: withoutBadges(s.badges, frames) };
    }),

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
 * Returns the badge (with its `state` when not "ok": signed-out, offline or
 * unknown, whose counts may be left out), `null` to clear it (a state this
 * version does not know), or `undefined` when the message isn't one.
 */
export function parseAppBadgeMessage(data: unknown): AppBadge | null | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'bulwark:app-badge' || msg.version !== 1) return undefined;
  let state: AppBadgeTrouble | undefined;
  if (msg.state !== undefined && msg.state !== 'ok') {
    if (typeof msg.state !== 'string') return undefined;
    if (!(APP_BADGE_STATES as readonly string[]).includes(msg.state)) return null;
    state = msg.state as AppBadgeTrouble;
  }
  // A count that cannot be trusted may come without one.
  const count = state && msg.count === undefined ? 0 : badgeNumber(msg.count);
  if (count === null) return undefined;
  const badge: AppBadge = { count };
  if (msg.mentions !== undefined) {
    const mentions = badgeNumber(msg.mentions);
    if (mentions === null) return undefined;
    badge.mentions = mentions;
  }
  if (state) badge.state = state;
  return badge;
}

/** The count drawn: a number, or only a dot for unread items. */
export type AppCountMark = { number: number } | { dot: true };

/**
 * What the rail draws for an app's badge: its count, or, when the count cannot
 * be trusted, a mark for that instead: "!" signed out, "?" offline (with the
 * last number, greyed), unknown or silent.
 */
export type AppBadgeMark =
  | AppCountMark
  | { state: AppBadgeTrouble; symbol: '!' | '?'; last: number | null };

function countMark(badge: AppBadge): AppCountMark | null {
  if (badge.mentions !== undefined) {
    if (badge.mentions > 0) return { number: badge.mentions };
    return badge.count > 0 ? { dot: true } : null;
  }
  return badge.count > 0 ? { number: badge.count } : null;
}

/**
 * How a badge shows on the rail: a number, or only a dot for unread items
 * when the app counts mentions separately and has none; for a count that
 * cannot be trusted its state's mark, offline with its last number.
 */
export function appBadgeMark(badge: AppBadge | undefined): AppBadgeMark | null {
  if (!badge) return null;
  if (!badge.state) return countMark(badge);
  const last = badge.state === 'offline' ? countMark(badge) : null;
  return {
    state: badge.state,
    symbol: badge.state === 'signed-out' ? '!' : '?',
    last: last && 'number' in last ? last.number : null,
  };
}
