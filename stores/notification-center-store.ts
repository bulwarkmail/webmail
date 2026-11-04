import { create } from 'zustand';
import { generateUUID } from '@/lib/utils';

// The in-app notification list behind the bell: what plugins showed with
// api.notifications.show and the app's own error and warning toasts. Kept in
// this browser only (localStorage), the last MAX_ENTRIES of them.

export const MAX_ENTRIES = 50;
const STORAGE_KEY = 'notification-center';

export interface CenterEntry {
  id: string;
  /** Unix ms. */
  time: number;
  level: 'error' | 'warning' | 'info';
  title: string;
  body: string;
  /** Set for plugin notifications: whose they are, and the tag the plugin passed. */
  pluginId?: string;
  pluginName?: string;
  tag?: string;
  /** A link the plugin added (checked by the host when it was shown). */
  action?: { label: string; url: string };
  read: boolean;
}

export type CenterEntryInput = Omit<CenterEntry, 'id' | 'time' | 'read'> & { time?: number };

interface NotificationCenterState {
  entries: CenterEntry[];
  add: (input: CenterEntryInput) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
}

function isEntry(value: unknown): value is CenterEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.time === 'number' && typeof e.title === 'string'
    && typeof e.body === 'string' && typeof e.read === 'boolean'
    && (e.level === 'error' || e.level === 'warning' || e.level === 'info')
    && (e.action === undefined || isLink(e.action));
}

// Storage is the user's own, but a link is only ever shown when it is http(s).
function isLink(value: unknown): value is { label: string; url: string } {
  if (!value || typeof value !== 'object') return false;
  const { label, url } = value as Record<string, unknown>;
  if (typeof label !== 'string' || typeof url !== 'string') return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function load(): CenterEntry[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function save(entries: CenterEntry[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage blocked or full: the list still works for this page load.
  }
}

export const useNotificationCenterStore = create<NotificationCenterState>((set, get) => ({
  entries: load(),

  add: (input) => {
    const entry: CenterEntry = {
      id: generateUUID(),
      time: input.time ?? Date.now(),
      level: input.level,
      title: input.title,
      body: input.body,
      ...(input.pluginId ? { pluginId: input.pluginId, pluginName: input.pluginName ?? input.pluginId } : {}),
      ...(input.tag ? { tag: input.tag } : {}),
      ...(input.action && isLink(input.action) ? { action: { label: input.action.label, url: input.action.url } } : {}),
      read: false,
    };
    const entries = [entry, ...get().entries].slice(0, MAX_ENTRIES);
    set({ entries });
    save(entries);
  },

  markRead: (id) => {
    const entries = get().entries.map((e) => (e.id === id && !e.read ? { ...e, read: true } : e));
    set({ entries });
    save(entries);
  },

  markAllRead: () => {
    const entries = get().entries.map((e) => (e.read ? e : { ...e, read: true }));
    set({ entries });
    save(entries);
  },

  clear: () => {
    set({ entries: [] });
    save([]);
  },
}));

export const selectUnreadCount = (s: NotificationCenterState) => s.entries.reduce((n, e) => n + (e.read ? 0 : 1), 0);

/** Add an entry from outside React (toast store, plugin host API). */
export function recordNotification(input: CenterEntryInput): void {
  try {
    useNotificationCenterStore.getState().add(input);
  } catch {
    // Never let the list break the thing that is being reported.
  }
}

/** Reads the list back from storage as a fresh page load would: the app lock puts it back at unlock. */
export function reloadNotificationCenter(): void {
  useNotificationCenterStore.setState({ entries: load() });
}
