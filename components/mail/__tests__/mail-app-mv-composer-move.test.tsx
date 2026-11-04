import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useUIStore } from '@/stores/ui-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// Mountain View draws the composer in a window, a card or the reading pane
// depending on the width, and React mounts it anew in each. What was typed has
// to come along, or a narrowed window silently empties the message.

const device = vi.hoisted(() => ({ current: { isMobile: false, isCompact: false, isDesktop: true } }));

vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onCompose }: { onCompose: () => void }) => <button onClick={onCompose}>stub compose</button>,
}));
// The real composer's contract: its state starts from initialData, and it hands
// its edits to onSaveState as it unmounts, only if it has any, through the
// handler of its first render. Text it started with is no edit.
vi.mock('@/components/email/email-composer', async () => {
  const { useEffect, useRef, useState } = await import('react');
  return {
    EmailComposer: ({ initialData, onSaveState }: {
      initialData?: { subject?: string } | null;
      onSaveState: (data: { subject: string }) => void;
    }) => {
      const [subject, setSubject] = useState(initialData?.subject ?? '');
      const initial = useRef(subject);
      const latest = useRef(subject);
      latest.current = subject;
      useEffect(() => () => {
        if (latest.current !== initial.current) onSaveState({ subject: latest.current });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <input aria-label="stub subject" value={subject} onChange={(e) => setSubject(e.target.value)} />;
    },
  };
});
vi.mock('@/components/search/mv-search-form', () => ({
  MvSearchForm: ({ onSearch }: { onSearch: () => void }) => <button onClick={onSearch}>stub filter search</button>,
}));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>message viewer</div> }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => [] }));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => device.current,
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));


const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 } as Mailbox;

beforeEach(() => {
  device.current = { isMobile: false, isCompact: false, isDesktop: true };
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'mountain-view', mailLayout: 'focus' } as never);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('moving the Mountain View composer between layouts', () => {
  it('keeps what was typed when the window narrows past the desktop width and back', async () => {
    const { rerender } = render(<MailApp />);
    fireEvent.click(screen.getByText('stub compose'));
    fireEvent.change(await screen.findByLabelText('stub subject'), { target: { value: 'Still here' } });

    device.current = { isMobile: true, isCompact: false, isDesktop: false };
    rerender(<MailApp />);
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('stub subject').value).toBe('Still here'));

    device.current = { isMobile: false, isCompact: false, isDesktop: true };
    rerender(<MailApp />);
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('stub subject').value).toBe('Still here'));
  });

  // Mountain View floats its composer on every desktop, compact included; a
  // phone has it in the reading pane.
  const setWidth = (rerender: (ui: React.ReactElement) => void, width: 'desktop' | 'phone') => {
    device.current = { isMobile: width === 'phone', isCompact: false, isDesktop: width === 'desktop' };
    rerender(<MailApp />);
  };
  const subject = () => screen.getByLabelText<HTMLInputElement>('stub subject');

  it('keeps text typed after the composer moved with nothing in it yet', async () => {
    const { rerender } = render(<MailApp />);
    fireEvent.click(screen.getByText('stub compose'));
    await screen.findByLabelText('stub subject');

    // Clean, so this move hands nothing over.
    setWidth(rerender, 'phone');
    fireEvent.change(await screen.findByLabelText('stub subject'), { target: { value: 'Typed in the pane' } });

    setWidth(rerender, 'desktop');
    await waitFor(() => expect(subject().value).toBe('Typed in the pane'));

    setWidth(rerender, 'phone');
    await waitFor(() => expect(subject().value).toBe('Typed in the pane'));
  });

  it('keeps text typed after moving back and forth untouched', async () => {
    const { rerender } = render(<MailApp />);
    fireEvent.click(screen.getByText('stub compose'));
    fireEvent.change(await screen.findByLabelText('stub subject'), { target: { value: 'First' } });

    setWidth(rerender, 'phone');
    await waitFor(() => expect(subject().value).toBe('First'));
    setWidth(rerender, 'desktop');
    await waitFor(() => expect(subject().value).toBe('First'));
    fireEvent.change(subject(), { target: { value: 'First and more' } });

    setWidth(rerender, 'phone');
    await waitFor(() => expect(subject().value).toBe('First and more'));
  });
});

describe('a composer opened from the phone drawer', () => {
  const openFromInsideDrawer = () => window.dispatchEvent(new CustomEvent('bulwark:mailto', {
    detail: { to: ['bob@example.org'], cc: [], bcc: [], subject: '', body: '' },
    cancelable: true,
  }));

  beforeEach(() => {
    device.current = { isMobile: true, isCompact: false, isDesktop: false };
    useSettingsStore.setState({ interfaceLayout: 'default' } as never);
    useUIStore.setState({ sidebarOpen: true });
  });

  it('closes the drawer instead of leaving the composer under it', async () => {
    render(<MailApp />);
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    openFromInsideDrawer();
    await screen.findByLabelText('stub subject');
    await waitFor(() => expect(useUIStore.getState().sidebarOpen).toBe(false));
  });

  it('lets the drawer open again over a composer that is already open', async () => {
    render(<MailApp />);
    openFromInsideDrawer();
    await screen.findByLabelText('stub subject');
    await waitFor(() => expect(useUIStore.getState().sidebarOpen).toBe(false));
    act(() => useUIStore.setState({ sidebarOpen: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });
});
