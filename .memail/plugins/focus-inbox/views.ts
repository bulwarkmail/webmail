import type { MessageListTabsConfig } from '../../../lib/plugin-types';

export const FOCUS_MODES = ['Unread correspondence and starred', 'All unread and starred', 'Starred only'] as const;
export type FocusMode = typeof FOCUS_MODES[number];
export interface FocusSettings {
  enabled?: boolean;
  showNewsletters?: boolean;
  showUnreadBadges?: boolean;
  focusMode?: FocusMode;
  accountNames?: string;
}
/** Literal sign-in names; no wildcard, sender search, or JMAP query syntax. */
export function accountScope(raw: unknown): string[] {
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('error.accountScope');
  const values = [...new Set(raw.split(/[,;\n]/).map(value => value.trim().toLowerCase()).filter(Boolean))];
  if ((raw.trim() && !values.length) || values.length > 20 || values.some(value => value.length > 254 || !/^[\p{L}\p{N}@._+%-]+$/u.test(value))) {
    throw new Error('error.accountScope');
  }
  return values;
}
export function buildFocusViews(settings: FocusSettings, t: (key: string) => string): MessageListTabsConfig | null {
  if (settings.enabled === false) return null;
  const mode = settings.focusMode ?? FOCUS_MODES[0];
  if (!(FOCUS_MODES as readonly string[]).includes(mode)) throw new Error('error.focusMode');
  const newsletters = { header: ['List-Unsubscribe'] };
  const starred = { hasKeyword: '$flagged' };
  const unread = { notKeyword: '$seen' };
  const correspondence = { operator: 'AND', conditions: [unread, { operator: 'NOT', conditions: [newsletters] }] };
  const focus = mode === 'Starred only' ? starred : {
    operator: 'OR', conditions: [starred, mode === 'All unread and starred' ? unread : correspondence],
  };
  const badge = settings.showUnreadBadges !== false;
  return {
    mailboxRoles: ['inbox'],
    tabs: [
      // A default tab means the complement of the others, not all mail.
      {id:'memail-all',label:t('tab.all'),icon:'inbox',order:0,showUnreadBadge:badge,query:{minSize:0}},
      {id:'memail-focus',label:t(mode === 'Starred only' ? 'tab.starred' : mode === 'All unread and starred' ? 'tab.unread' : 'tab.focus'),icon:'focus',order:10,showUnreadBadge:badge,query:focus},
      ...(settings.showNewsletters === false ? [] : [
        {id:'memail-newsletters',label:t('tab.newsletters'),icon:'news',order:20,showUnreadBadge:badge,query:newsletters},
      ]),
    ],
  };
}
