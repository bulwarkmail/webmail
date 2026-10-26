import { beforeEach, describe, expect, it } from 'vitest';
import { generateAccountId } from '@/lib/account-utils';
import { useAccountStore } from '@/stores/account-store';
import { type BrowserAccount, XenaxioApiError } from '../api';
import { accountServerUrl, applyBrowserAccounts, otherCompanyPortal, userIdOf } from '../accounts';

const HERE = 'https://portal.botkontor.com/api/jmap';

function register(email: string, serverUrl = HERE): string {
  return useAccountStore.getState().addAccount({
    label: email,
    serverUrl,
    username: email,
    authMode: 'basic',
    rememberMe: false,
    displayName: email,
    email,
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: true,
  });
}

function account(email: string, portalUrl: string, active = false): BrowserAccount {
  return { userId: `id-${email}`, email, displayName: email.split('@')[0] ?? email, company: 'Firma', portalUrl, active };
}

// Step 29: the account menu shows what the platform keeps signed in in this browser.
describe('applyBrowserAccounts', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  });

  it('lists the other accounts without a mail connection and drops what is no longer signed in', () => {
    const stale = register('old@botkontor.com');
    const active = register('es@botkontor.com');
    applyBrowserAccounts(
      [
        account('es@botkontor.com', 'https://portal.botkontor.com', true),
        account('es@hanse.agency', 'https://hanse-agency.xenaxio.com'),
        account('anna@botkontor.com', 'https://portal.botkontor.com'),
      ],
      active,
    );

    const { accounts } = useAccountStore.getState();
    expect(accounts.find((a) => a.id === stale)).toBeUndefined();
    expect(accounts.map((a) => [a.email, a.isDefault, a.isConnected])).toEqual([
      ['es@botkontor.com', true, true],
      ['es@hanse.agency', false, false],
      ['anna@botkontor.com', false, false],
    ]);
    // Keyed by the account's own portal, as it is when it is the active one there.
    const hanse = generateAccountId('es@hanse.agency', 'https://hanse-agency.xenaxio.com/api/jmap');
    expect(accounts[1]?.id).toBe(hanse);
    expect(accounts[1]?.serverUrl).toBe(accountServerUrl('https://hanse-agency.xenaxio.com/'));
    expect(userIdOf(hanse)).toBe('id-es@hanse.agency');
    expect(userIdOf(active)).toBe('id-es@botkontor.com');
  });

  it('keeps the menu at the platform list when it is called again', () => {
    const active = register('es@botkontor.com');
    const list = [account('es@botkontor.com', 'https://portal.botkontor.com', true), account('es@hanse.agency', 'https://hanse-agency.xenaxio.com')];
    applyBrowserAccounts(list, active);
    applyBrowserAccounts(list, active);
    expect(useAccountStore.getState().accounts).toHaveLength(2);
    applyBrowserAccounts([list[0] as BrowserAccount], active);
    expect(useAccountStore.getState().accounts.map((a) => a.email)).toEqual(['es@botkontor.com']);
  });
});

describe('step 39: another company is added on its own portal', () => {
  it('links only the https portal the platform named', () => {
    const refused = (portalUrl: unknown) => new XenaxioApiError(409, 'account_other_company', { portalUrl });
    expect(otherCompanyPortal(refused('https://beta.xenaxio.com'))).toBe('https://beta.xenaxio.com');
    expect(otherCompanyPortal(refused('https://beta.xenaxio.com/x?y'))).toBe('https://beta.xenaxio.com');
    expect(otherCompanyPortal(refused('javascript:alert(1)'))).toBe(null);
    expect(otherCompanyPortal(refused(42))).toBe(null);
    expect(otherCompanyPortal(new XenaxioApiError(400, 'too_many_accounts'))).toBe(null);
    expect(otherCompanyPortal(new Error('x'))).toBe(null);
  });
});
