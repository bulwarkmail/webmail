"use client";

import { useEffect } from 'react';
import { useConfig } from '@/hooks/use-config';
import { useIsFocusedProTab, usePaneId } from '@/hooks/use-pane-context';
import { useAccountStore } from '@/stores/account-store';
import { formatTabTitle } from '@/lib/tab-title';

// The surface that set the title last owns it. One that is still mounted
// (during a route transition) stops re-applying, so two titles never fight.
let owner: symbol | null = null;

/**
 * Sets the browser-tab title for a surface: "<context> - <account> - <app>"
 * (see formatTabTitle). Pass a context that is already localized, or nothing
 * for a surface that has nothing to add.
 *
 * Next renders the root layout's metadata <title> again on every client-side
 * navigation, after the new surface has mounted, which puts the bare app name
 * back. So the title is re-applied whenever <head> changes and it is not ours.
 */
export function useDocumentTitle(context?: string | null): void {
  const { appName } = useConfig();
  // The account actually in view, so two windows on two accounts stay apart.
  const account = useAccountStore(
    (s) => s.accounts.find((a) => a.id === s.activeAccountId)?.email || null,
  );
  const title = formatTabTitle(context, account, appName);
  // The Pro shell keeps every opened tab mounted (hidden), so only the
  // focused tab may claim the title; outside Pro every surface is in view.
  const paneId = usePaneId();
  const focusedProTab = useIsFocusedProTab();
  const inView = paneId === null || focusedProTab;

  useEffect(() => {
    if (!inView) return;
    const self = Symbol('document-title');
    owner = self;
    // Termination: setting the title is itself a <head> mutation; on that run
    // the title is already ours and nothing is written.
    const apply = () => {
      if (owner === self && document.title !== title) document.title = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (owner === self) owner = null;
    };
  }, [title, inView]);
}
