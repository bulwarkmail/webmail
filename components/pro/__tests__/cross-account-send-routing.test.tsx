import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

/**
 * #461 - the Pro "From" dropdown lists identities from every connected
 * account. Sending through the *active* account's client while using another
 * account's identity makes the server fall back to its own primary identity,
 * so the message goes out DKIM-signed with the wrong domain key. The compose
 * tab must submit through the client of the account owning the identity.
 */

// The composer itself is irrelevant here - stub it down to a button that
// fires the onSend payload the real composer builds for a cross-account
// identity (raw identity id + owning local account id).
const payloadRef = vi.hoisted(() => ({ current: {} as Record<string, unknown>, outcome: null as Promise<unknown> | null }));

vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend }: { onSend?: (d: Record<string, unknown>) => Promise<unknown> }) =>
    React.createElement(
      'button',
      { onClick: () => { payloadRef.outcome = onSend?.(payloadRef.current) ?? null; } },
      'send',
    ),
}));

vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  ComposerErrorFallback: () => null,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/lib/debug', () => ({
  debug: { log: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('@/stores/toast-store', () => ({
  toast: { error: () => {}, success: () => {}, warning: () => {} },
}));

// vi.mock factories are hoisted above module-level consts, so the clients
// have to be created in a hoisted block to be visible inside them.
const { activeClient, otherClient } = vi.hoisted(() => {
  const makeClient = (label: string) => ({
    label,
    getAccountId: () => `jmap-${label}`,
    setKeyword: async () => {},
    deleteEmail: async () => {},
    getThreadEmails: async () => [],
  });
  return { activeClient: makeClient('account-1'), otherClient: makeClient('account-2') };
});

vi.mock('@/stores/auth-store', () => {
  const state = {
    client: activeClient,
    activeAccountId: 'local-1',
    getClientForAccount: (id: string) => (id === 'local-2' ? otherClient : undefined),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  return { useAuthStore: hook };
});

const { sendEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn(async (...args: unknown[]) => {
    void args;
    return { scheduled: false };
  }),
}));

vi.mock('@/stores/email-store', () => {
  const state = {
    sendEmail: (...args: unknown[]) => sendEmail(...args),
    refreshCurrentMailbox: async () => {},
    fetchScheduledEmails: async () => {},
    refreshScheduledMetadata: async () => {},
    isScheduledView: false,
    emails: [],
    expandedThreadIds: new Set<string>(),
    threadEmailsCache: new Map(),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = () => {};
  return { useEmailStore: hook };
});

vi.mock('@/stores/pro-tab-store', () => {
  const state = {
    closeTab: () => {},
    updateTabTitle: () => {},
    updateComposeDraft: () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  return {
    useProTabStore: hook,
    registerProTabCloseInterceptor: () => () => {},
  };
});

import { ProComposeTabBody } from '../pro-compose-tab-body';
import { useAuthStore } from '@/stores/auth-store';

const TAB_DATA = { sessionId: 1, mode: 'compose' as const, title: 'New message' };

const basePayload = {
  to: ['someone@example.org'],
  cc: [],
  bcc: [],
  subject: 'Hi',
  body: 'text',
  identityId: 'identity-on-account-2',
  fromEmail: 'alias@domain2.com',
};

describe('Pro compose tab - cross-account send routing (#461)', () => {
  beforeEach(() => {
    sendEmail.mockClear();
  });

  it('submits through the client of the account owning the selected identity', async () => {
    payloadRef.current = { ...basePayload, localAccountId: 'local-2' };
    render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);

    fireEvent.click(screen.getByText('send'));

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    const args = sendEmail.mock.calls[0] as unknown[];
    expect(args[0]).toBe(otherClient);
    expect(args[6]).toBe('identity-on-account-2');
    // The owning account travels on to the store so undo-send can cancel the
    // submission on the right server.
    expect(args[args.length - 1]).toMatchObject({ localAccountId: 'local-2' });
  });

  it('falls back to the active client for same-account identities', async () => {
    payloadRef.current = { ...basePayload };
    render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);

    fireEvent.click(screen.getByText('send'));

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail.mock.calls[0][0]).toBe(activeClient);
  });

  it('falls back to the active client when the owning account is no longer connected', async () => {
    payloadRef.current = { ...basePayload, localAccountId: 'local-gone' };
    render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);

    fireEvent.click(screen.getByText('send'));

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail.mock.calls[0][0]).toBe(activeClient);
  });

  // The composer removes a draft version saved through another login only
  // once the message is out; without a connection nothing went.
  it('tells the composer nothing was sent when there is no connection', async () => {
    const auth = useAuthStore.getState() as unknown as { client: unknown };
    const connected = auth.client;
    auth.client = null;
    try {
      payloadRef.current = { ...basePayload, localAccountId: 'local-2' };
      render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);

      fireEvent.click(screen.getByText('send'));

      await expect(payloadRef.outcome).resolves.toBe(false);
      expect(sendEmail).not.toHaveBeenCalled();
    } finally {
      auth.client = connected;
    }
  });
});

describe('Pro compose tab - what the composer chose', () => {
  beforeEach(() => {
    sendEmail.mockClear();
  });

  it('sends with the priority, read receipt, DSN, REQUIRETLS, plugin headers and label the composer chose', async () => {
    payloadRef.current = {
      ...basePayload,
      requestReadReceipt: true,
      requestDsn: true,
      requireTls: true,
      priority: 'high',
      headers: { 'X-Plugin': '1' },
      labelHeaders: { 'header:SIO-Label:asRaw': ' marking="CONFIDENTIAL"' },
    };
    render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);

    fireEvent.click(screen.getByText('send'));

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    const args = sendEmail.mock.calls[0] as unknown[];
    expect(args[args.length - 1]).toMatchObject({
      requestReadReceipt: true,
      requestDsn: true,
      requireTls: true,
      priority: 'high',
      headers: { 'X-Plugin': '1' },
      labelHeaders: { 'header:SIO-Label:asRaw': ' marking="CONFIDENTIAL"' },
    });
  });
});
