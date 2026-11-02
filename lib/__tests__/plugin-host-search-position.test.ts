import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

// api.email.search pages with `position`, so a plugin can go past the
// first 50 results (the assistant's batches of more than 50 messages).

const READER = {
  id: 'reader', name: 'Reader', version: '1.0.0', author: 'test', description: '',
  type: 'hook', permissions: ['email:read'], grantedPermissions: ['email:read'], entrypoint: 'index.js',
  enabled: true, status: 'running', settings: {},
} as InstalledPlugin;
const search = (query: unknown) => dispatchApiCall(READER, 'email.search', [query]);

let client: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  client = {
    getEmails: vi.fn(async () => ({ emails: [], hasMore: false, total: 0 })),
    getMailboxes: vi.fn(async () => []),
    getAccountId: vi.fn(() => 'acc1'),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
  useEmailStore.setState({ mailboxes: [], selectedEmail: null });
});

afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('api.email.search position', () => {
  it('asks the server for the page after `position` results', async () => {
    await search({ text: 'invoice', limit: 50, position: 50 });
    expect(client.getEmails).toHaveBeenCalledWith(undefined, undefined, 50, 50, undefined, false, { text: 'invoice' });
  });

  it('starts at the first result without it', async () => {
    await search({ text: 'invoice' });
    expect(client.getEmails).toHaveBeenCalledWith(undefined, undefined, 20, 0, undefined, false, { text: 'invoice' });
  });

  it('takes whole numbers from 0 to 1,000,000 only', async () => {
    await expect(search({ text: 'x', position: -1 })).rejects.toThrow(/position must be a whole number from 0 to 1000000/);
    await expect(search({ text: 'x', position: 1.5 })).rejects.toThrow(/position must be a whole number/);
    await expect(search({ text: 'x', position: '10' })).rejects.toThrow(/position must be a whole number/);
    expect(client.getEmails).not.toHaveBeenCalled();
  });
});
