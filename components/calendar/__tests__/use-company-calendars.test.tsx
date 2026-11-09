import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const load = vi.fn(async () => []);
vi.mock('@/lib/company-calendars', async (original) => ({
  ...(await original<typeof import('@/lib/company-calendars')>()),
  loadFeedEvents: (...args: unknown[]) => load(...(args as [])),
}));

import { useCompanyCalendars } from '../use-company-calendars';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Two logins can share a JMAP account id (two servers): the cached feed
// events are kept per login.

const FEED = { id: 'hol', name: 'Holidays', url: '', urlHeld: true, color: '#16a34a', refreshMinutes: 60 };

function Harness({ client }: { client: IJMAPClient }) {
  useCompanyCalendars(client);
  return null;
}

describe('useCompanyCalendars', () => {
  afterEach(() => load.mockClear());

  it('keys the feed cache by the login, not the JMAP account id alone', async () => {
    const policy = usePolicyStore.getState().policy;
    usePolicyStore.setState({ policy: { ...policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, calendars: { feeds: [FEED], freeBusyGroup: '' } } } });
    const client = { getUsername: () => 'alice@example.org', getAccountId: () => 'b' } as unknown as IJMAPClient;
    render(createElement(Harness, { client }));
    await waitFor(() => expect(load).toHaveBeenCalledWith(client, 'alice@example.org|b', FEED));
  });
});
