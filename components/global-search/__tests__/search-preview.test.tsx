import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

// The search tab's preview of a mail hit reads the message through the
// login the hit came through, and a draft reopened there is saved over and
// removed through it - the active login's hits included: userb is account
// `e` on the 0.16.23 and the 1.0 test server alike.

const viewProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/components/pro/pro-email-tab-body', () => ({
  ProEmailView: (props: Record<string, unknown>) => {
    viewProps.current = props;
    return null;
  },
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

const clients = vi.hoisted(() => ({ v016: { label: '0.16.23' }, v10: { label: '1.0' } }));
vi.mock('@/stores/auth-store', () => {
  const state = {
    activeAccountId: 'userb@v016',
    getClientForAccount: (id: string) => (id === 'userb@v016' ? clients.v016 : id === 'userb@v10' ? clients.v10 : undefined),
  };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useAuthStore: hook };
});

import { SearchPreview } from '../search-preview';
import type { MailHit } from '@/lib/global-search/types';

const hit = (localAccountId: string): MailHit => ({
  kind: 'mail', localAccountId, jmapAccountId: 'e', id: 'eaaaaab', accountLabel: localAccountId,
  title: 'Draft', subtitle: 'Drafts', date: null, source: 'remote', snippet: null,
  email: { id: 'eaaaaab' } as MailHit['email'],
});

describe('search preview of a mail hit', () => {
  beforeEach(() => {
    viewProps.current = null;
  });

  it('names the active login for a hit of the active login', () => {
    render(<SearchPreview hit={hit('userb@v016')} onOpen={vi.fn()} onClose={vi.fn()} />);

    expect(viewProps.current).toMatchObject({ client: clients.v016, clientAccountId: 'userb@v016', accountId: 'e' });
  });

  it('names the other login for a hit of another login', () => {
    render(<SearchPreview hit={hit('userb@v10')} onOpen={vi.fn()} onClose={vi.fn()} />);

    expect(viewProps.current).toMatchObject({ client: clients.v10, clientAccountId: 'userb@v10', accountId: 'e' });
  });

  it('shows nothing of a hit whose login has no client, and reads nothing through the active one', () => {
    const view = render(<SearchPreview hit={hit('userb@gone')} onOpen={vi.fn()} onClose={vi.fn()} />);

    expect(viewProps.current).toBeNull();
    expect(view.getByText('not_connected')).toBeTruthy();
  });
});
