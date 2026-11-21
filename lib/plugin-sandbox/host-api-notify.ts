// Host side of api.notifications.show: a system notification when the user
// has allowed them for the webmail, otherwise a toast. Every one names the
// plugin that sent it, and a plugin may send only a few a minute.
//
// A notification may carry one link ("Open in Paperless"). The host draws
// it, so it looks like the app's own: it may only point at a server the
// plugin already talks to (its httpOrigins or the server of one of its proxy
// credentials). Otherwise any plugin with ui:notifications could put an
// app-styled button to any site in front of the user.

import type { InstalledPlugin, NotificationInput } from '../plugin-types';
import { toast as appToast } from '@/stores/toast-store';
import { toastHooks } from '../plugin-hooks';
import { readObject, readString, withinRate } from './host-api-input';
import { recordNotification } from '@/stores/notification-center-store';
import { credentialOverview } from './connect-dialog';
import { useSettingsStore } from '@/stores/settings-store';

export const MAX_NOTIFICATION_TITLE = 120;
export const MAX_NOTIFICATION_BODY = 300;
export const NOTIFICATIONS_PER_MINUTE = 5;
export const MAX_NOTIFICATION_ACTION_LABEL = 40;
const MAX_ACTION_URL = 2048;
const TAG_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Marks and controls that change the direction of the text around them. */
const DIRECTION_MARKS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A plugin's text as one line the host can show: line breaks and other
 * control characters become spaces, direction marks go.
 */
// eslint-disable-next-line no-control-regex -- line breaks and other control characters become spaces
export const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(DIRECTION_MARKS, '').trim();

/**
 * Show a notification from a plugin. Resolves to 'system' when the browser
 * showed it, 'toast' when the app did. Clicking a system notification
 * brings the webmail to the front and fires onNotificationClick for this
 * plugin only, with the tag it passed.
 */
export async function doNotificationsShow(plugin: InstalledPlugin, input: unknown): Promise<'system' | 'toast'> {
  const method = 'notifications.show';
  const data = readObject(input, method, 'notification', ['title', 'body', 'tag', 'action']) as NotificationInput & Record<string, unknown>;
  const title = oneLine(readString(data.title, method, 'title', MAX_NOTIFICATION_TITLE, { min: 1 }));
  if (!title) throw new Error(`${method}: title must not be empty`);
  const body = data.body === undefined ? '' : oneLine(readString(data.body, method, 'body', MAX_NOTIFICATION_BODY));
  let tag: string | undefined;
  if (data.tag !== undefined) {
    if (typeof data.tag !== 'string' || !TAG_RE.test(data.tag)) {
      throw new Error(`${method}: tag must be 1-64 letters, digits or . _ : -`);
    }
    tag = data.tag;
  }
  const action = data.action === undefined ? undefined : readAction(method, data.action);
  if (!withinRate('notifications', plugin.id, NOTIFICATIONS_PER_MINUTE)) {
    throw new Error(`${method}: at most ${NOTIFICATIONS_PER_MINUTE} notifications a minute`);
  }
  if (action && !(await pluginOrigins(plugin)).has(new URL(action.url).origin)) {
    throw new Error(`${method}: action.url must be on a server the plugin talks to (its httpOrigins or a proxy credential's server)`);
  }

  const source = plugin.name || plugin.id;
  // Also listed in the app's notification panel (the bell), where a click
  // reaches the plugin the same way as a click on the system notification.
  recordNotification({ level: 'info', title, body, pluginId: plugin.id, pluginName: source, ...(tag ? { tag } : {}), ...(action ? { action } : {}) });
  // Do not disturb: no system notification (with its sound) from the page;
  // the quiet toast below and the bell's list still have it.
  const doNotDisturb = useSettingsStore.getState().doNotDisturb;
  if (!doNotDisturb && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const notification = new Notification(title, {
        body: body ? `${body}\n${source}` : source,
        // Scoped to the plugin, so one plugin's tag can't replace another's notification.
        ...(tag ? { tag: `plugin:${plugin.id}:${tag}` } : {}),
      });
      notification.onclick = () => {
        try { window.focus(); } catch { /* ignore */ }
        notification.close();
        void toastHooks.onNotificationClick.emitTo(plugin.id, { tag: tag ?? '' });
      };
      return 'system';
    } catch {
      // Some browsers (Chrome on Android) only allow notifications from a
      // service worker; the toast below still tells the user.
    }
  }
  appToast.info(title, {
    message: body ? `${body} (${source})` : source,
    ...(action ? { action: { label: action.label, onClick: () => openNotificationLink(action.url) } } : {}),
  });
  return 'toast';
}

function readAction(method: string, value: unknown): { label: string; url: string } {
  const data = readObject(value, method, 'action', ['label', 'url']);
  const label = oneLine(readString(data.label, method, 'action.label', MAX_NOTIFICATION_ACTION_LABEL, { min: 1 }));
  if (!label) throw new Error(`${method}: action.label must not be empty`);
  const raw = readString(data.url, method, 'action.url', MAX_ACTION_URL, { min: 1 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${method}: action.url must be an absolute URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${method}: action.url must be http or https`);
  if (url.username || url.password) throw new Error(`${method}: action.url must not carry a user name or password`);
  return { label, url: url.href };
}

/** Origins the plugin reaches: its manifest's httpOrigins and its credentials' servers. */
async function pluginOrigins(plugin: InstalledPlugin): Promise<Set<string>> {
  const origins = new Set<string>();
  for (const o of plugin.httpOrigins ?? []) {
    try { origins.add(new URL(o).origin); } catch { /* invalid entries never matched anything */ }
  }
  if (plugin.permissions.includes('http:proxy')) {
    const { credentials, adminOrigins } = await credentialOverview(plugin.id);
    for (const c of credentials) if (c.pluginId === plugin.id && c.origin) origins.add(c.origin);
    for (const o of adminOrigins) origins.add(o);
  }
  return origins;
}

/** Open a notification's link in a new tab, without giving that tab a handle on the webmail. */
export function openNotificationLink(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}
