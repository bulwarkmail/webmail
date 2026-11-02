// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { listReachableHosts, noThirdPartyCspSources } from '@/lib/admin/reachable-hosts';

const policy = { pushRelays: [], pushRelayUrl: '', defaultSidebarApps: [], features: { sidebarAppsEnabled: false, calendarEnabled: false } };

function hosts(config: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
  return listReachableHosts({ get: (key) => config[key], policy, env, buildRelayUrl: '' });
}

// No third-party traffic (#903) still allows the hosts the admin set: the
// error tracker is one of them, and the page's CSP must let browsers reach it.
describe('error reporting in the no-third-party list', () => {
  it('is listed, without the key, only when a DSN is set', () => {
    expect(hosts({}).filter((h) => h.kind === 'Error reporting')).toEqual([]);
    const listed = hosts({ errorReportingDsn: 'https://6f0b9c79ed3a4315b76595bc2536ac40@errors.example.org/3' })
      .filter((h) => h.kind === 'Error reporting');
    expect(listed).toEqual([{ kind: 'Error reporting', host: 'errors.example.org', origin: 'https://errors.example.org', setIn: 'ERROR_REPORTING_DSN', side: 'both' }]);
    expect(noThirdPartyCspSources(listed, false).connect).toEqual(['https://errors.example.org']);
  });
});
