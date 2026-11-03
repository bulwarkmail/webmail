import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

// The mail tab hands every compose tab the selected message as replyTo, a new
// message too. A new message was titled after whatever message was open.

vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => React.createElement('div') }));
vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  ComposerErrorFallback: () => null,
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: () => {}, success: () => {}, warning: () => {} } }));

const { updateTabTitle, hookOf } = vi.hoisted(() => ({
  updateTabTitle: vi.fn(),
  hookOf: (state: Record<string, unknown>) => {
    const hook = (sel?: (s: Record<string, unknown>) => unknown) => (sel ? sel(state) : state);
    hook.getState = () => state;
    return hook;
  },
}));
vi.mock('@/stores/email-store', () => ({ useEmailStore: hookOf({ mailboxes: [], selectedMailbox: null, viewingAccountId: null }) }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: hookOf({ client: null, activeAccountId: 'a' }) }));
vi.mock('@/stores/account-store', () => ({ useAccountStore: hookOf({ getAccountById: () => undefined }) }));
vi.mock('@/stores/pro-tab-store', () => ({
  useProTabStore: hookOf({ closeTab: () => {}, updateTabTitle, updateComposeDraft: () => {} }),
  registerProTabCloseInterceptor: () => () => {},
}));

import { ProComposeTabBody } from '../pro-compose-tab-body';

const selected = { subject: 'Invoice August' };

describe('Pro compose tab title', () => {
  beforeEach(() => updateTabTitle.mockClear());

  it('stays the new-message title with a message selected in the mail tab', () => {
    render(<ProComposeTabBody tabId="t" data={{ sessionId: 1, mode: 'compose', title: 'New message', replyTo: selected }} />);
    expect(updateTabTitle).toHaveBeenLastCalledWith('t', 'New message');
  });

  it('keeps the prefix the opener gave a reply', () => {
    render(<ProComposeTabBody tabId="t" data={{ sessionId: 1, mode: 'reply', title: 'Re: Invoice August', replyTo: selected }} />);
    expect(updateTabTitle).toHaveBeenLastCalledWith('t', 'Re: Invoice August');
  });

  it('follows the subject of a reopened draft', () => {
    render(<ProComposeTabBody tabId="t" data={{ sessionId: 1, mode: 'compose', title: 'x', initialData: { subject: 'Lunch?' } as never }} />);
    expect(updateTabTitle).toHaveBeenLastCalledWith('t', 'Lunch?');
  });
});
