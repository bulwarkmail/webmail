'use client';

// Native tab strip for plugin-registered message-list category tabs
// (Gmail-style Primary / Promotions / Social / Updates). Renders above the
// email list; the active tab's resolved JMAP filter is ANDed into the
// mailbox query by email-store.fetchEmails. Plugins only contribute tab
// DEFINITIONS (stores/message-list-tabs-store.ts) - no plugin iframe here.

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { iconForName } from '@/components/icons';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { isFilterEmpty } from '@/lib/jmap/search-utils';
import { cn } from '@/lib/utils';

/**
 * The DOM id of a category tab, which labels the panel while it is active.
 * `panelId` is the id of the element around the message list (useId in the
 * mail view, so two mounted mail views don't share ids).
 */
const categoryTabDomId = (panelId: string, tabId: string) => `${panelId}-tab-${tabId}`;

/** Whether the category strip is shown for the current view. */
export function useMessageListTabsVisible(): boolean {
  const tabs = useMessageListTabsStore((s) => s.tabs);
  const mailboxRoles = useMessageListTabsStore((s) => s.mailboxRoles);
  const selectedMailbox = useEmailStore((s) => s.selectedMailbox);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const selectedKeyword = useEmailStore((s) => s.selectedKeyword);
  const searchQuery = useEmailStore((s) => s.searchQuery);
  const filtersEmpty = useEmailStore((s) => isFilterEmpty(s.searchFilters));
  const isUnifiedView = useEmailStore((s) => s.isUnifiedView);
  const role = mailboxes.find((mb) => mb.id === selectedMailbox)?.role?.toLowerCase() ?? null;
  // Tabs only make sense on a plain mailbox view: tag views, searches and
  // unified fan-outs bypass the category filter in fetchEmails, so the strip
  // must disappear rather than lie about what's being shown.
  return (
    tabs.length > 0 &&
    !!role &&
    mailboxRoles.includes(role) &&
    !selectedKeyword &&
    !searchQuery &&
    filtersEmpty &&
    !isUnifiedView
  );
}

/**
 * Props for the element around the message list: a tab panel labelled by
 * the active category while the strip is shown, a plain box otherwise. The
 * element stays the same either way, so the list never remounts.
 */
export function useMessageListPanelProps(panelId: string): { id: string; role?: 'tabpanel'; 'aria-labelledby'?: string } {
  const visible = useMessageListTabsVisible();
  const activeTabId = useMessageListTabsStore((s) => s.activeTabId);
  if (!visible || !activeTabId) return { id: panelId };
  return { id: panelId, role: 'tabpanel', 'aria-labelledby': categoryTabDomId(panelId, activeTabId) };
}

export function MessageListTabs({ panelId }: { panelId: string }) {
  const t = useTranslations('email_list');
  const tShell = useTranslations('shell');
  const tabs = useMessageListTabsStore((s) => s.tabs);
  const activeTabId = useMessageListTabsStore((s) => s.activeTabId);
  const tabCounts = useMessageListTabsStore((s) => s.tabCounts);

  const selectedMailbox = useEmailStore((s) => s.selectedMailbox);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const client = useAuthStore((s) => s.client);

  const mailbox = mailboxes.find((mb) => mb.id === selectedMailbox);
  const visible = useMessageListTabsVisible();

  useEffect(() => {
    if (!visible || !client || !mailbox) return;
    const jmapMailboxId = mailbox.originalId || mailbox.id;
    const accountId = mailbox.isShared ? mailbox.accountId : undefined;
    void useMessageListTabsStore.getState().refreshCounts(client, jmapMailboxId, accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, client, selectedMailbox, tabs]);

  // A plugin registering (or clearing) tabs after the list was fetched leaves
  // the visible list out of sync with the strip's active-tab filter - refetch
  // exactly when the merged tab set changes, never on ordinary view switches
  // (those already refetch through their own flows).
  const prevTabsRef = useRef(tabs);
  useEffect(() => {
    if (prevTabsRef.current === tabs) return;
    prevTabsRef.current = tabs;
    if (client) void useEmailStore.getState().fetchEmails(client);
  }, [tabs, client]);

  if (!visible) return null;
  // One tab stop: the active tab, or the first while none is.
  const tabStopId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id;

  const handleSelect = (tabId: string) => {
    if (tabId === activeTabId) return;
    useMessageListTabsStore.getState().setActiveTab(tabId, selectedMailbox);
    if (client) void useEmailStore.getState().fetchEmails(client);
  };

  // Arrow keys, Home and End move between the tabs; Enter or Space opens
  // one (manual activation, since each switch fetches the list again).
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) return;
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next = -1;
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = (current + 1) % buttons.length;
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = (current - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    if (next === -1) return;
    e.preventDefault();
    e.stopPropagation();
    buttons[next].focus();
  };

  return (
    <div
      className="flex items-stretch gap-1 px-2 border-b border-border overflow-x-auto shrink-0"
      style={{ scrollbarWidth: 'none' }}
      role="tablist"
      aria-label={t('category_tabs')}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon
          ? iconForName(tab.icon)
          : undefined;
        const unread = tabCounts[tab.id] ?? 0;
        const isActive = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            id={categoryTabDomId(panelId, tab.id)}
            role="tab"
            aria-selected={isActive}
            aria-controls={isActive ? panelId : undefined}
            tabIndex={tab.id === tabStopId ? 0 : -1}
            onClick={() => handleSelect(tab.id)}
            className={cn(
              'relative flex items-center gap-1.5 px-3.5 py-2.5 text-sm whitespace-nowrap select-none',
              'border-b-2 -mb-px rounded-t-md transition-colors duration-150',
              'focus-visible:outline-hidden focus-inset',
              isActive
                ? 'border-primary text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40',
            )}
            style={isActive && tab.color ? { borderBottomColor: tab.color } : undefined}
          >
            {Icon && (
              <Icon
                className={cn('h-4 w-4 flex-shrink-0', !isActive && 'opacity-70')}
                style={isActive && tab.color ? { color: tab.color } : undefined}
              />
            )}
            <span>{tab.label}</span>
            {tab.showUnreadBadge !== false && unread > 0 && (
              <span
                className={cn(
                  'text-xs font-semibold tabular-nums',
                  isActive ? 'text-foreground' : 'text-muted-foreground',
                )}
                title={tShell('folder_unread', { count: unread })}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
