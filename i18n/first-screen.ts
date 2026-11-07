type Messages = Record<string, unknown>;

/**
 * The parts of the catalog the sign-in page and the mail view draw before
 * anything is clicked. The server hands those pages only these (layouts read
 * the route), and IntlProvider fetches the rest after the first paint: the
 * whole catalog in the page was over 400 KB of script data to serialise,
 * download and parse before the first row. A key outside these shows nothing
 * (never its raw name) until the rest has arrived, and the page draws again
 * then. scripts/boot-skeleton-guard checks that the sign-in page and the mail
 * view miss none; lib/__tests__/first-screen-catalog.test.ts keeps the size
 * in check.
 *
 * Paths name a namespace ("sidebar") or a part of one ("settings.density").
 */
export const FIRST_SCREEN_MESSAGES: readonly string[] = [
  // Small namespaces whole.
  'accessibility_panel', 'advanced_search', 'app_update', 'command_palette', 'common', 'compose_ux',
  'confirm_dialog', 'context_menu', 'desktopReminders', 'email_list', 'fileDrop', 'login',
  'mail_list_extra', 'mail_p2_list', 'notification_center', 'protocol_handlers', 'pwaNotify', 'shell',
  'shortcuts', 'sidebar', 'sidebar_apps', 'threads', 'top_bar', 'totp_reauth', 'uxs_login', 'welcome',
  // The sign-in page's notices: why the session ended, a wipe, mail the outbox lost.
  'offlineWipe', 'session_limits',
  // The keys the first screen draws from the big ones.
  'calendar.notifications.alert_title',
  'email_viewer.frame_title_from', 'email_viewer.no_conversation_description', 'email_viewer.no_conversation_selected',
  'email_viewer.no_subject', 'email_viewer.quick_reply_placeholder', 'email_viewer.unknown_sender', 'email_viewer.unread',
  'mail_import.menu_import',
  'mailbox_context_menu.placeholder_folder_name', 'mailbox_context_menu.prompt_new_folder',
  'offline.signout.lost', 'offline.outbox.no_subject',
  'notifications.undo', 'notifications.undo_done', 'notifications.undo_failed', 'notifications.undo_hint', 'notifications.undone',
  'proofreading.shortcuts',
  'settings.appearance.theme',
  'tour.take_a_tour',
];

/**
 * What a message or conversation opened from a link draws as well: the reader
 * is on its first screen (/mail/message/..., /mail/thread/...). Pop-out and
 * desktop message windows aren't on a first-screen surface and get the whole
 * catalog.
 */
export const READER_FIRST_SCREEN_MESSAGES: readonly string[] = [
  'compose_words', 'deep_link', 'email_viewer', 'mail_p2_conv', 'mail_p3_actions', 'reader_actions',
];

/** Whether `pathname` opens a message or conversation in the mail view. */
export function opensReader(pathname: string): boolean {
  return /\/mail\/(message|thread)\/[^/]/.test(pathname);
}

/** The catalog paths the first screen of `pathname` draws. */
export function firstScreenPaths(pathname: string): readonly string[] {
  return opensReader(pathname) ? [...FIRST_SCREEN_MESSAGES, ...READER_FIRST_SCREEN_MESSAGES] : FIRST_SCREEN_MESSAGES;
}

/** The surfaces whose server catalog is only the first screen's. */
export const FIRST_SCREEN_SURFACES: ReadonlySet<string> = new Set(['mail', 'login']);

/**
 * Every object of the catalog, empty: a translator made for a namespace the
 * first screen doesn't draw holds its (empty) object, and the rest of the
 * catalog is laid into that same object when it comes. About 12 KB.
 */
export function catalogShape(messages: Messages): Messages {
  const out: Messages = {};
  for (const [key, value] of Object.entries(messages)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = catalogShape(value as Messages);
  }
  return out;
}

/**
 * `messages` cut down to `paths`, inside the catalog's shape (catalogShape).
 * Paths that aren't in it are skipped.
 */
export function pickMessages(messages: Messages, paths: readonly string[]): Messages {
  const out = catalogShape(messages);
  const whole = new Set<string>();
  // Shorter paths first: a part of a namespace already taken whole is in it.
  for (const path of [...paths].sort((a, b) => a.split('.').length - b.split('.').length)) {
    const parts = path.split('.');
    if (parts.some((_, i) => whole.has(parts.slice(0, i + 1).join('.')))) continue;
    whole.add(path);
    let from: unknown = messages;
    for (const part of parts) {
      from = from && typeof from === 'object' ? (from as Messages)[part] : undefined;
    }
    if (from === undefined) continue;
    let to = out;
    for (const part of parts.slice(0, -1)) {
      const next = to[part];
      to = (next && typeof next === 'object' ? next : (to[part] = {})) as Messages;
    }
    to[parts[parts.length - 1]] = from;
  }
  return out;
}

/**
 * Lays `full` into `partial` in place: what the first screen got stays the same
 * objects, so translators made from it see the rest without drawing again.
 */
export function fillIn(partial: Messages, full: Messages): void {
  for (const [key, value] of Object.entries(full)) {
    const have = partial[key];
    if (have === undefined) partial[key] = value;
    else if (have && value && typeof have === 'object' && typeof value === 'object' && !Array.isArray(have)) {
      fillIn(have as Messages, value as Messages);
    }
  }
}
