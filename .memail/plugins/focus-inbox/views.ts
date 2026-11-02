import type { MessageListTabsConfig } from '../../../lib/plugin-types';

export interface FocusSettings {
  enabled?: boolean;
  showNewsletters?: boolean;
  showUnreadBadges?: boolean;
}
export function buildFocusViews(settings: FocusSettings, t: (key: string) => string): MessageListTabsConfig | null {
  if (settings.enabled === false) return null;
  const newsletters = { header: ['List-Unsubscribe'] };
  const badge = settings.showUnreadBadges !== false;
  return {
    mailboxRoles: ['inbox'],
    tabs: [
      // Every tab has a positive query. An empty/default tab would mean the
      // complement of the others in Bulwark, not all messages.
      {id:'memail-all',label:t('tab.all'),icon:'inbox',order:0,showUnreadBadge:badge,query:{minSize:0}},
      {id:'memail-focus',label:t('tab.focus'),icon:'focus',order:10,showUnreadBadge:badge,query:{
        operator:'OR',conditions:[
          {hasKeyword:'$flagged'},
          {operator:'AND',conditions:[{notKeyword:'$seen'},{operator:'NOT',conditions:[newsletters]}]},
        ],
      }},
      ...(settings.showNewsletters === false ? [] : [
        {id:'memail-newsletters',label:t('tab.newsletters'),icon:'news',order:20,showUnreadBadge:badge,query:newsletters},
      ]),
    ],
  };
}
