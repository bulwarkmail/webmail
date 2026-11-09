import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { onOpenEmail, proEmailTabOpener, resetOpenEmail, type OpenableEmail } from '../plugin-sandbox/open-email';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { useProTabStore } from '@/stores/pro-tab-store';
import { useAuthStore } from '@/stores/auth-store';

// api.ui.openEmail: a plugin opens a message in the reader, as a click on a
// search result entry naming one does, also one of a shared or group account.

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'p1', name: 'Plugin One', version: '1.0.0', author: '', description: '', type: 'hook',
    permissions: ['email:read'], entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, managed: true,
    ...overrides,
  };
}

/** The messages each JMAP account has. */
const messages: Record<string, string[]> = { 'acc-1': ['m1'], 'group-1': ['g1'], 'acc-2': ['m2'] };

/** A login whose primary account is `primary`, reading `shared` accounts too. */
const client = (primary: string, shared: string[] = []) => ({
  getAccountId: () => primary,
  getSharedAccounts: () => [primary, ...shared].map((id) => ({ id, name: id, isPrimary: id === primary, capabilities: { mail: true } })),
  getEmailFields: vi.fn(async (ids: string[], _properties: string[], accountId?: string) =>
    ids.filter((id) => messages[accountId ?? primary]?.includes(id)).map((id) => ({ id }))),
});

const opened: OpenableEmail[] = [];
const mailPage = async (email: OpenableEmail) => {
  opened.push(email);
  return messages[email.sourceAccountId]?.includes(email.id) ? 'opened' as const : 'missing' as const;
};

beforeEach(() => {
  resetOpenEmail();
  resetPluginRateLimits();
  opened.length = 0;
  const clients = new Map([['login-2', client('acc-2')], ['login-1', client('acc-1', ['group-1'])]]);
  useAuthStore.setState({ activeAccountId: 'login-1', getAllConnectedClients: () => clients } as never);
});

afterEach(() => {
  resetOpenEmail();
});

describe('ui.openEmail', () => {
  it('needs email:read', async () => {
    onOpenEmail(mailPage);
    await expect(dispatchApiCall(plugin({ permissions: [] }), 'ui.openEmail', [{ id: 'm1' }])).rejects.toThrow(/lacks permission "email:read"/);
    expect(opened).toEqual([]);
  });

  it('opens a message of the signed-in account on the mail page', async () => {
    onOpenEmail(mailPage);
    await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1' }])).resolves.toBeUndefined();
    expect(opened).toEqual([{ id: 'm1', sourceClientAccountId: 'login-1', sourceAccountId: 'acc-1' }]);
  });

  it('opens a group account\'s message through the login that reads it', async () => {
    onOpenEmail(mailPage);
    await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'g1', accountId: 'group-1' }]);
    await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm2', accountId: 'acc-2' }]);
    expect(opened).toEqual([
      { id: 'g1', sourceClientAccountId: 'login-1', sourceAccountId: 'group-1' },
      { id: 'm2', sourceClientAccountId: 'login-2', sourceAccountId: 'acc-2' },
    ]);
  });

  it('refuses an account no login reads, and a message its account does not have', async () => {
    onOpenEmail(mailPage);
    await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'x1', accountId: 'elsewhere' }])).rejects.toThrow(/cannot read the account "elsewhere"/);
    expect(opened).toEqual([]);
    await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'nope' }])).rejects.toThrow(/no message "nope"/);
  });

  it('refuses what is not a message reference', async () => {
    onOpenEmail(mailPage);
    await expect(dispatchApiCall(plugin(), 'ui.openEmail', ['m1'])).rejects.toThrow(/must be an object/);
    await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: '' }])).rejects.toThrow(/id must be a string/);
    await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1', accountId: 7 }])).rejects.toThrow(/accountId must be a string/);
    await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1', mailboxId: 'inbox' }])).rejects.toThrow(/unknown property "mailboxId"/);
    expect(opened).toEqual([]);
  });

  it('asks the mail page mounted last', async () => {
    const first: string[] = [];
    onOpenEmail(async (email) => { first.push(email.id); return 'opened'; });
    const stop = onOpenEmail(mailPage);
    await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1' }]);
    stop();
    await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1' }]);
    expect(opened.map((e) => e.id)).toEqual(['m1']);
    expect(first).toEqual(['m1']);
  });

  it('opens at most 30 messages a minute in place', async () => {
    onOpenEmail(mailPage);
    for (let i = 0; i < 30; i++) await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1' }]);
    await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1' }])).rejects.toThrow(/at most 30 times a minute/);
    expect(opened).toHaveLength(30);
    // Another plugin has its own budget.
    await dispatchApiCall(plugin({ id: 'p2' }), 'ui.openEmail', [{ id: 'm1' }]);
    expect(opened).toHaveLength(31);
  });

  it('passes on why the mail page could not open it', async () => {
    onOpenEmail(async () => new Error('the mail page is not ready'));
    await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1' }])).rejects.toThrow('ui.openEmail: the mail page is not ready');
  });

  describe('in the Pro shell', () => {
    beforeEach(() => {
      useProTabStore.setState(useProTabStore.getInitialState(), true);
      onOpenEmail(proEmailTabOpener('Loading…'));
    });

    it('opens the message in an email tab, naming its login and account', async () => {
      await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'g1', accountId: 'group-1' }]);
      const tabs = useProTabStore.getState().tabs.filter((t) => t.kind === 'email');
      expect(tabs.map((t) => t.emailData)).toEqual([
        { accountId: 'group-1', clientAccountId: 'login-1', emailId: 'g1', mailboxId: null, title: 'Loading…' },
      ]);
      expect(useProTabStore.getState().activeTabId).toBe(tabs[0].id);
    });

    it('opens no tab for a message its account does not have', async () => {
      await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'g9', accountId: 'group-1' }])).rejects.toThrow(/no message "g9"/);
      expect(useProTabStore.getState().tabs.filter((t) => t.kind === 'email')).toEqual([]);
    });
  });

  describe('off the mail page', () => {
    const assign = vi.fn();
    const original = window.location;
    beforeEach(() => {
      assign.mockReset();
      Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
    });
    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    });

    it('loads the message\'s link, naming login and account only when not the active own', async () => {
      await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1' }]);
      await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'g1', accountId: 'group-1' }]);
      await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm2', accountId: 'acc-2' }]);
      expect(assign.mock.calls.map(([href]) => href)).toEqual([
        '/mail/message/m1',
        '/mail/message/g1?owner=group-1',
        '/mail/message/m2?account=login-2',
      ]);
    });

    it('loads a link at most five times a minute', async () => {
      for (let i = 0; i < 5; i++) await dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1' }]);
      await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'm1' }])).rejects.toThrow(/at most 5 times a minute/);
      expect(assign).toHaveBeenCalledTimes(5);
    });

    it('refuses a message its account does not have without leaving the page', async () => {
      await expect(dispatchApiCall(plugin(), 'ui.openEmail', [{ id: 'g9', accountId: 'group-1' }])).rejects.toThrow(/no message "g9"/);
      expect(assign).not.toHaveBeenCalled();
    });
  });
});
