'use client';

// Native tab strip for plugin-registered message-list category tabs
// (Gmail-style Primary / Promotions / Social / Updates). Renders above the
// email list; the active tab's resolved JMAP filter is ANDed into the
// mailbox query by email-store.fetchEmails. Plugins only contribute tab
// DEFINITIONS (stores/message-list-tabs-store.ts) - no plugin iframe here.

import { useEffect, useRef } from 'react';
import { iconForName } from '@/components/icons';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { cn } from '@/lib/utils';

export function MessageListTabs() {
  const tabs = useMessageListTabsStore((s) => s.tabs);
  const mailboxRoles = useMessageListTabsStore((s) => s.mailboxRoles);
  const activeTabId = useMessageListTabsStore((s) => s.activeTabId);
  const tabCounts = useMessageListTabsStore((s) => s.tabCounts);

  const selectedMailbox = useEmailStore((s) => s.selectedMailbox);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const selectedKeyword = useEmailStore((s) => s.selectedKeyword);
  const searchQuery = useEmailStore((s) => s.searchQuery);
  const isUnifiedView = useEmailStore((s) => s.isUnifiedView);
  const client = useAuthStore((s) => s.client);

  const mailbox = mailboxes.find((mb) => mb.id === selectedMailbox);
  const role = mailbox?.role?.toLowerCase() ?? null;
  // Tabs only make sense on a plain mailbox view: tag views, searches and
  // unified fan-outs bypass the category filter in fetchEmails, so the strip
  // must disappear rather than lie about what's being shown.
  const visible =
    tabs.length > 0 &&
    !!role &&
    mailboxRoles.includes(role) &&
    !selectedKeyword &&
    !searchQuery &&
    !isUnifiedView;

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

  const handleSelect = (tabId: string) => {
    if (tabId === activeTabId) return;
    useMessageListTabsStore.getState().setActiveTab(tabId, selectedMailbox);
    if (client) void useEmailStore.getState().fetchEmails(client);
  };

  return (
    <div
      className="flex items-stretch gap-1 px-2 border-b border-border overflow-x-auto shrink-0"
      style={{ scrollbarWidth: 'none' }}
      role="tablist"
      aria-label="Inbox categories"
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
            role="tab"
            aria-selected={isActive}
            onClick={() => handleSelect(tab.id)}
            className={cn(
              'relative flex items-center gap-1.5 px-3.5 py-2.5 text-sm whitespace-nowrap select-none',
              'border-b-2 -mb-px rounded-t-md transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
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
                title={`${unread} unread`}
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
