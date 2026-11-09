import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useVacationStore } from '@/stores/vacation-store';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

// The out-of-office's forward and the host: vacation.get says it can't tell
// when the filters couldn't be read (instead of "no forward"), and no plugin
// may switch the reply on while it forwards mail or while that isn't known.

function plugin(perms: string[]): InstalledPlugin {
  return {
    id: 'ooo', name: 'ooo', version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}
const P = plugin(['vacation:read', 'vacation:write']);
const call = (method: string, ...args: unknown[]) => dispatchApiCall(P, method, args);

const REPLY = { id: 'singleton', isEnabled: false, fromDate: null, toDate: null, subject: 'Away', textBody: 'Back soon', htmlBody: null };
const FORWARDING = [
  '/* @metadata:begin',
  JSON.stringify({ version: 2, rules: [], includeVacation: true, vacationForward: { enabled: true, to: 'x@example.com', keepCopy: true } }),
  '@metadata:end */',
  'require ["include"];',
  'include :personal :optional "vacation";',
].join('\n');

let script: string | null;
let sieveFails: boolean;
let client: IJMAPClient;

beforeEach(() => {
  script = null;
  sieveFails = false;
  client = {
    getAccountId: () => 'acc1',
    supportsVacationResponse: () => true,
    supportsSieve: () => true,
    getSieveAccountId: () => 'acc1',
    getSieveCapabilities: () => ({ sieveExtensions: ['include', 'vacation', 'copy'] }),
    getVacationResponse: vi.fn(async () => REPLY),
    setVacationResponse: vi.fn(async () => {}),
    getSieveScripts: vi.fn(async () => {
      if (sieveFails) throw new Error('SieveScript/get failed');
      return script ? [{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }] : [];
    }),
    getSieveScriptContent: vi.fn(async () => script ?? ''),
  } as unknown as IJMAPClient;
  useAuthStore.setState({ client });
  useVacationStore.getState().clearState();
});
afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('vacation.get', () => {
  it('says whether the out-of-office forwards, and null when the filters can\'t be read', async () => {
    expect(await call('vacation.get')).toMatchObject({ forwardActive: false });
    script = FORWARDING;
    expect(await call('vacation.get')).toMatchObject({ forwardActive: true });
    sieveFails = true;
    expect(await call('vacation.get')).toMatchObject({ forwardActive: null });
  });
});

describe('vacation.set', () => {
  it('refuses to switch the reply on while it forwards mail, for any plugin', async () => {
    script = FORWARDING;
    await expect(call('vacation.set', { isEnabled: true, subject: 'Away' })).rejects.toThrow(/forwards mail to another address/);
    expect(client.setVacationResponse).not.toHaveBeenCalled();
  });

  it('refuses while that can\'t be read, and still lets a plugin switch it off', async () => {
    sieveFails = true;
    await expect(call('vacation.set', { isEnabled: true, subject: 'Away' })).rejects.toThrow(/can't be read/);
    expect(client.setVacationResponse).not.toHaveBeenCalled();
    await call('vacation.set', { isEnabled: false });
    expect(client.setVacationResponse).toHaveBeenCalledTimes(1);
  });

  it('switches it on when no forward is set', async () => {
    await call('vacation.set', { isEnabled: true, subject: 'Away' });
    expect(client.setVacationResponse).toHaveBeenCalledWith(expect.objectContaining({ isEnabled: true }), undefined);
  });
});
