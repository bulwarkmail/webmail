import { describe, expect, it } from 'vitest';
import {
  isLabelExtraHeaderName,
  DEFAULT_ORGANISATION_POLICY,
  MIN_FEED_REFRESH_MINUTES,
  mergeOrganisation,
  sanitizeOrganisationPartial,
  sanitizeOrganisationPolicy,
} from '../organisation-policy';
import { resolvePolicy } from '../policy-scopes';
import { DEFAULT_POLICY } from '../types';

// The enterprise-pack sections of policy.json: everything off by default,
// hand-written input sanitised, and the merge rules across scopes.

const label = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), ...extra });

describe('enterprise sections: defaults and sanitising', () => {
  it('keeps everything off when nothing is set', () => {
    const org = sanitizeOrganisationPolicy({});
    expect(org.phishingReport).toEqual({ address: '', format: 'forward' });
    expect(org.labels).toEqual({ list: [], defaultId: '', required: false, extraHeader: '' });
    expect(org.announcement.text).toEqual({});
    expect(Object.values(org.devices).every((v) => v === false)).toBe(true);
    expect(org.calendars).toEqual({ feeds: [], freeBusyGroup: '' });
    expect(org.retention).toEqual({ trashDays: 0, junkDays: 0 });
  });

  it('takes a valid phishing address and format, and refuses anything else', () => {
    expect(sanitizeOrganisationPolicy({ phishingReport: { address: ' SOC@Example.org ', format: 'arf' } }).phishingReport)
      .toEqual({ address: 'soc@example.org', format: 'arf' });
    expect(sanitizeOrganisationPolicy({ phishingReport: { address: 'not an address', format: 'pdf' } }).phishingReport)
      .toEqual(DEFAULT_ORGANISATION_POLICY.phishingReport);
  });

  it('cleans labels: no line breaks or quotes in header values, a fallback colour, unique ids', () => {
    const { labels } = sanitizeOrganisationPolicy({ labels: {
      list: [
        label('conf', { marking: 'CONFIDENTIAL"\r\nBcc: x@evil.test', color: 'red', sensitivity: 'Company-Confidential', subjectPrefix: '[Conf]\n' }),
        label('conf'),
        { id: 'bad id!', name: 'x' },
        { id: 'noname' },
      ],
      defaultId: 'conf',
      required: true,
      extraHeader: 'X-Classification',
    } });
    expect(labels.list).toHaveLength(1);
    expect(labels.list[0].marking).toBe('CONFIDENTIAL Bcc: x@evil.test');
    expect(labels.list[0].marking).not.toMatch(/[\r\n"]/);
    expect(labels.list[0].subjectPrefix).toBe('[Conf]');
    expect(labels.list[0].color).toBe('#6b7280');
    expect(labels).toMatchObject({ defaultId: 'conf', required: true, extraHeader: 'X-Classification' });
  });

  it('refuses an extra header that would replace a real one', () => {
    for (const name of ['Subject', 'bcc', 'SIO-Label', 'Content-Type', 'X Bad']) {
      expect(sanitizeOrganisationPolicy({ labels: { extraHeader: name } }).labels.extraHeader).toBe('');
    }
  });

  it('takes any RFC 5322 header name, msip_labels too, but not one the server refuses', () => {
    expect(sanitizeOrganisationPolicy({ labels: { extraHeader: 'msip_labels' } }).labels.extraHeader).toBe('msip_labels');
    expect(isLabelExtraHeaderName('msip_labels')).toBe(true);
    for (const name of ['Content-Classification', 'List-Id', 'Resent-From', 'ARC-Seal', 'Auto-Submitted', 'X:Bad', 'X Bad']) {
      expect(isLabelExtraHeaderName(name)).toBe(false);
      expect(sanitizeOrganisationPolicy({ labels: { extraHeader: name } }).labels.extraHeader).toBe('');
    }
  });

  it('refuses the header Bulwark keeps the label of a draft in', () => {
    expect(sanitizeOrganisationPolicy({ labels: { extraHeader: 'X-Bulwark-Label' } }).labels.extraHeader).toBe('');
    expect(isLabelExtraHeaderName('X-Bulwark-Label')).toBe(false);
    expect(isLabelExtraHeaderName('X-Classification')).toBe(true);
  });

  it('keeps announcement text per locale and normalises times', () => {
    const { announcement } = sanitizeOrganisationPolicy({ announcement: {
      id: 'maint-1', severity: 'warning', text: { en: 'Maintenance tonight', 'pt-BR': 'Manutenção', 'x y': 'no', de: '  ' },
      fallbackLocale: 'en', startsAt: '2026-11-01T20:00:00+01:00', endsAt: 'tomorrow', dismissible: false,
    } });
    expect(announcement.text).toEqual({ en: 'Maintenance tonight', 'pt-BR': 'Manutenção' });
    expect(announcement.startsAt).toBe('2026-11-01T19:00:00.000Z');
    expect(announcement.endsAt).toBe('');
    expect(announcement).toMatchObject({ id: 'maint-1', severity: 'warning', dismissible: false });
  });

  it('takes http and https feeds (webcal as https), and a refresh of at least an hour', () => {
    const { calendars } = sanitizeOrganisationPolicy({ calendars: {
      feeds: [
        { id: 'hol', name: 'Holidays', url: 'webcal://cal.example.org/holidays.ics', refreshMinutes: 5 },
        { id: 'intra', name: 'Intranet', url: 'http://intranet.local/team.ics', color: '#ABCDEF', refreshMinutes: 240 },
        { id: 'js', name: 'Bad', url: 'javascript:alert(1)' },
      ],
      freeBusyGroup: 'All-Staff@example.org',
    } });
    expect(calendars.feeds.map((f) => f.id)).toEqual(['hol', 'intra']);
    expect(calendars.feeds[0].url).toBe('https://cal.example.org/holidays.ics');
    expect(calendars.feeds[0].refreshMinutes).toBe(MIN_FEED_REFRESH_MINUTES);
    expect(calendars.feeds[1]).toMatchObject({ color: '#abcdef', refreshMinutes: 240 });
    expect(calendars.freeBusyGroup).toBe('all-staff@example.org');
  });

  it('keeps a feed whose address the server held back, and drops one without an address', () => {
    const { calendars } = sanitizeOrganisationPolicy({ calendars: { feeds: [
      { id: 'kept', name: 'Holidays', url: '', urlHeld: true },
      { id: 'none', name: 'No address' },
      { id: 'empty', name: 'Typed nothing yet', url: '' },
    ] } });
    expect(calendars.feeds.map((f) => [f.id, f.url, f.urlHeld])).toEqual([['kept', '', true]]);
  });

  it('keeps device switches only as booleans', () => {
    const { devices } = sanitizeOrganisationPolicy({ devices: { noDownloads: true, noPrint: 'yes', watermark: 1 } });
    expect(devices.noDownloads).toBe(true);
    expect(devices.noPrint).toBe(false);
    expect(devices.watermark).toBe(false);
  });
});

describe('enterprise sections: merging scopes', () => {
  const base = sanitizeOrganisationPolicy({
    labels: { list: [label('pub'), label('int')], defaultId: 'int', required: true, extraHeader: 'X-Class' },
    announcement: { id: 'all', severity: 'info', text: { en: 'For everyone' }, endsAt: '2026-12-01T00:00:00Z' },
    vacationTemplates: { library: [{ id: 'a', name: 'Company' }] },
    calendars: { feeds: [{ id: 'hol', name: 'Holidays', url: 'https://cal.example.org/h.ics' }] },
  });

  it('replaces the label scheme as a whole and clears a default the new list lacks', () => {
    const merged = mergeOrganisation(base, sanitizeOrganisationPartial({ labels: { list: [label('vsnfd')] } }));
    expect(merged.labels.list.map((l) => l.id)).toEqual(['vsnfd']);
    expect(merged.labels.defaultId).toBe('');
    expect(merged.labels.extraHeader).toBe('');
    expect(merged.labels.required).toBe(false);
  });

  it('drops "required" when a scope leaves no label to pick', () => {
    const merged = mergeOrganisation(base, sanitizeOrganisationPartial({ labels: { required: true } }));
    expect(merged.labels.list).toEqual([]);
    expect(merged.labels.required).toBe(false);
  });

  it("doesn't mix a scope's announcement with Everyone's", () => {
    const merged = mergeOrganisation(base, sanitizeOrganisationPartial({ announcement: { id: 'dept', text: { en: 'Only us' } } }));
    expect(merged.announcement).toMatchObject({ id: 'dept', text: { en: 'Only us' }, endsAt: '' });
  });

  it('adds a scope\'s out-of-office templates and company calendars to Everyone\'s', () => {
    const merged = mergeOrganisation(base, sanitizeOrganisationPartial({
      vacationTemplates: { library: [{ id: 'b', name: 'Sales' }] },
      calendars: { feeds: [{ id: 'sales', name: 'Sales events', url: 'https://cal.example.org/s.ics' }] },
    }));
    expect(merged.vacationTemplates.library.map((t) => t.id)).toEqual(['a', 'b']);
    expect(merged.calendars.feeds.map((f) => f.id)).toEqual(['hol', 'sales']);
  });

  it('applies through resolvePolicy for a group scope', () => {
    const policy = {
      ...DEFAULT_POLICY,
      organisation: { calendars: { feeds: [{ id: 'hol', name: 'Holidays', url: 'https://cal.example.org/h.ics' }] } },
      scopes: [{ id: 'team', label: 'Team', match: { groups: ['team@example.org'] }, policy: {
        organisation: { calendars: { feeds: [{ id: 'team', name: 'Team', url: 'https://cal.example.org/t.ics' }] }, devices: { noDownloads: true } },
      } }],
    };
    const member = resolvePolicy(policy as never, { email: 'a@example.org', groups: ['team@example.org'] }).policy.organisation!;
    const other = resolvePolicy(policy as never, { email: 'c@example.org', groups: [] }).policy.organisation!;
    expect(member.calendars.feeds.map((f) => f.id)).toEqual(['hol', 'team']);
    expect(member.devices.noDownloads).toBe(true);
    expect(other.calendars.feeds.map((f) => f.id)).toEqual(['hol']);
    expect(other.devices.noDownloads).toBe(false);
  });
});
