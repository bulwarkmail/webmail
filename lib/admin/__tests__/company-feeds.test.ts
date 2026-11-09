import { describe, expect, it } from 'vitest';
import { allFeeds, feedForSubject, intranetFeedHost, stripFeedUrls } from '../company-feeds';
import { listReachableHosts } from '../reachable-hosts';
import { sanitizeOrganisationPolicy } from '../organisation-policy';
import type { SettingsPolicy } from '../types';

const policy = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  organisation: { calendars: { feeds: [{ id: 'hol', name: 'Holidays', url: 'https://cal.example.org/h.ics?token=t', color: '#2563eb', refreshMinutes: 60 }], freeBusyGroup: '' } },
  scopes: [
    { id: 'team', label: 'Team', match: { groups: ['team@example.org'] }, policy: { organisation: { calendars: { feeds: [{ id: 'team', name: 'Team', url: 'http://intranet.example.org/team.ics', refreshMinutes: 120 }] } } } },
    { id: 'two', label: 'Org two', match: { domains: ['two.example'] }, policy: { organisation: { calendars: { feeds: [{ id: 'two', name: 'Two', url: 'https://two.example/cal.ics' }] } } } },
  ],
} as unknown as SettingsPolicy;

describe('company feeds on the server', () => {
  it('empties every address in the policy users get, and the browser keeps the feeds', () => {
    const stripped = stripFeedUrls(policy);
    expect(stripped.organisation?.calendars.feeds[0]).toMatchObject({ id: 'hol', name: 'Holidays', url: '', urlHeld: true });
    expect((stripped.scopes![0].policy.organisation as { calendars: { feeds: { url: string }[] } }).calendars.feeds[0].url).toBe('');
    // The original is untouched (the admin pages read it).
    expect(policy.organisation?.calendars.feeds[0].url).toContain('token=t');
    // An emptied address survives the sanitiser the browser runs.
    expect(sanitizeOrganisationPolicy(stripped.organisation).calendars.feeds.map((f) => [f.id, f.url])).toEqual([['hol', '']]);
  });

  it('resolves a feed id only for a subject its scope applies to', () => {
    expect(feedForSubject(policy, { email: 'a@example.org', groups: ['team@example.org'] }, 'team')?.url).toBe('http://intranet.example.org/team.ics');
    expect(feedForSubject(policy, { email: 'a@example.org', groups: [] }, 'team')).toBeNull();
    expect(feedForSubject(policy, { email: 'a@example.org', groups: [] }, 'hol')?.name).toBe('Holidays');
    expect(feedForSubject(policy, { email: 'a@example.org', groups: [] }, 'two')).toBeNull();
    expect(feedForSubject(policy, { email: 'b@two.example', groups: [] }, 'two')?.name).toBe('Two');
  });

  it('lifts the private-address block only for a host that names the intranet', () => {
    expect(intranetFeedHost({ url: 'http://calendar.corp.internal/team.ics' })).toBe('calendar.corp.internal');
    expect(intranetFeedHost({ url: 'http://intranet/team.ics' })).toBe('intranet');
    expect(intranetFeedHost({ url: 'http://10.1.2.3/team.ics' })).toBe('10.1.2.3');
    expect(intranetFeedHost({ url: 'https://cal.example.org/h.ics' })).toBeNull();
    expect(intranetFeedHost({ url: 'http://127.0.0.1:8080/h.ics' })).toBeNull();
    expect(intranetFeedHost({ url: 'http://169.254.169.254/latest' })).toBeNull();
    expect(intranetFeedHost({ url: 'http://localhost/h.ics' })).toBeNull();
  });

  it('lists every scope\'s feed host as reachable', () => {
    expect(allFeeds(policy).map((f) => f.id)).toEqual(['hol', 'team', 'two']);
    const hosts = listReachableHosts({ get: () => undefined, policy, env: {} })
      .filter((h) => h.kind === 'Company calendar');
    expect(hosts.map((h) => [h.host, h.setIn, h.side])).toEqual([
      ['cal.example.org', 'Organisation > Calendars (Holidays)', 'server'],
      ['intranet.example.org', 'Organisation > Calendars (Team)', 'server'],
      ['two.example', 'Organisation > Calendars (Two)', 'server'],
    ]);
  });
});
