'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth-store';
import { TITLE_UNTIL_LOADED, useProTabStore, type ProTab } from '@/stores/pro-tab-store';

/**
 * With the local store on, stored tabs have no subjects. A tab's body puts its
 * title back, but only an open tab has a body, so the others are asked for here.
 */
export function useRestoredTabTitles(tabs: readonly ProTab[]): void {
  const t = useTranslations('email_composer');
  const updateTabTitle = useProTabStore((s) => s.updateTabTitle);
  const client = useAuthStore((s) => s.client);
  const waiting = tabs.filter((tab) => tab.kind === 'email' && tab.title === TITLE_UNTIL_LOADED && tab.emailData);
  const key = waiting.map((tab) => tab.id).join(' ');

  useEffect(() => {
    if (!key || !client) return;
    let stale = false;
    for (const tab of waiting) {
      const data = tab.emailData!;
      const owner = data.clientAccountId ? useAuthStore.getState().getClientForAccount(data.clientAccountId) : client;
      // Its login is gone or not back yet. The next render asks again.
      if (!owner) continue;
      void owner.getEmail(data.emailId, data.accountId).then((email) => {
        if (!stale && email) updateTabTitle(tab.id, email.subject || t('no_subject'));
      }).catch(() => {});
    }
    return () => { stale = true; };
    // `waiting` follows `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client, updateTabTitle]);
}
