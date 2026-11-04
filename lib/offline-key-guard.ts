/**
 * Keys that change mail on the server: archive, delete, read/unread, spam,
 * star. Offline with no mail kept on the device they can't run, and before
 * this they did nothing at all.
 */
export const MAIL_CHANGE_SHORTCUTS = ['onArchive', 'onDelete', 'onMarkAsRead', 'onMarkAsUnread', 'onToggleSpam', 'onToggleStar'] as const;

type Handler = (...args: never[]) => unknown;

/**
 * The same handlers, with those keys answering `onRefused` instead while
 * `canChangeMail()` is false. A key with no handler stays without one.
 */
export function guardOfflineMailChanges<T extends object>(handlers: T, canChangeMail: () => boolean, onRefused: () => void): T {
  const guarded = { ...handlers } as Record<string, unknown>;
  for (const key of MAIL_CHANGE_SHORTCUTS) {
    const handler = (handlers as Record<string, unknown>)[key] as Handler | undefined;
    if (typeof handler !== 'function') continue;
    guarded[key] = (...args: never[]) => {
      if (!canChangeMail()) {
        onRefused();
        return undefined;
      }
      return handler(...args);
    };
  }
  return guarded as T;
}
