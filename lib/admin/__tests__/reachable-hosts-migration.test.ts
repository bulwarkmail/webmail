// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { USER_ENTERED, listReachableHosts } from '@/lib/admin/reachable-hosts';
import type { SettingsPolicy } from '@/lib/admin/types';

const policy = { pushRelays: [], pushRelayUrl: '', defaultSidebarApps: [], features: { sidebarAppsEnabled: false, calendarEnabled: false } } as unknown as SettingsPolicy;

describe('mailbox migration in the reachable hosts', () => {
  it('lists every configured source host, and the user-entered entry when the option is on', () => {
    const migration = {
      sources: [{ name: 'Old OX', imap: { host: 'imap.ox.example.com', port: 993 }, sieve: { host: 'imap.ox.example.com', port: 4190 }, caldavUrl: 'https://dav.ox.example.com/caldav/' }],
      userEntered: true,
    };
    const hosts = listReachableHosts({ get: () => undefined, policy, env: {}, buildRelayUrl: '', migration }).filter((h) => h.kind.startsWith('Migration'));
    expect(hosts).toEqual([
      { kind: 'Migration source', host: 'imap.ox.example.com:993', setIn: 'Mailbox migration > Source servers (Old OX)', side: 'server' },
      { kind: 'Migration source', host: 'imap.ox.example.com:4190', setIn: 'Mailbox migration > Source servers (Old OX)', side: 'server' },
      { kind: 'Migration source', host: 'dav.ox.example.com', origin: 'https://dav.ox.example.com', setIn: 'Mailbox migration > Source servers (Old OX)', side: 'server' },
      { kind: 'Migration source users enter', host: USER_ENTERED, setIn: 'Mailbox migration > Options', side: 'server' },
    ]);
    const off = listReachableHosts({ get: () => undefined, policy, env: {}, buildRelayUrl: '', migration: { ...migration, userEntered: false } });
    expect(off.some((h) => h.kind === 'Migration source users enter')).toBe(false);
  });
});
