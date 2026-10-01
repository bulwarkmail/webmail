import { describe, expect, it } from 'vitest';

import { buildMentionCandidates, filterMentionCandidates, mentionLabel } from '../recipient-mentions';

describe('mentionLabel', () => {
  it('takes the first name from a display name', () => {
    expect(mentionLabel('Max Mustermann', 'mm@dornig.de')).toBe('Max');
    expect(mentionLabel('Mustermann, Max', 'mm@dornig.de')).toBe('Max');
    expect(mentionLabel('Dr. Max Mustermann', 'mm@dornig.de')).toBe('Max');
    expect(mentionLabel('Prof. Dr.-Ing. Max Mustermann', 'mm@dornig.de')).toBe('Max');
    expect(mentionLabel('Jürgen Müller', 'jm@dornig.de')).toBe('Jürgen');
    expect(mentionLabel("'Max Mustermann'", 'mm@dornig.de')).toBe('Max');
  });

  it('takes the first name from a firstname.lastname address when no name is known', () => {
    expect(mentionLabel(undefined, 'max.mustermann@dornig.de')).toBe('Max');
    expect(mentionLabel('', 'anna-lena.schmidt@dornig.de')).toBe('Anna-Lena');
    expect(mentionLabel(undefined, 'max.mustermann+rechnungen@dornig.de')).toBe('Max');
    expect(mentionLabel(undefined, 'juergen.mueller@dornig.de')).toBe('Juergen');
    expect(mentionLabel(undefined, 'info@dornig.de')).toBe('Info');
  });

  it('lets a firstname.lastname address tell which word of the name is the first name', () => {
    expect(mentionLabel('Mustermann Max', 'max.mustermann@dornig.de')).toBe('Max');
    expect(mentionLabel('Müller Jürgen', 'juergen.mueller@dornig.de')).toBe('Jürgen');
    expect(mentionLabel('Dornig GmbH - Max Mustermann', 'max.mustermann@dornig.de')).toBe('Max');
    // A one-part mailbox name confirms nothing: it may be the last name.
    expect(mentionLabel('Max Mustermann', 'mustermann@dornig.de')).toBe('Max');
  });

  it('treats a display name that is an address or mailbox name like the address', () => {
    expect(mentionLabel('max.mustermann@dornig.de', 'max.mustermann@dornig.de')).toBe('Max');
    expect(mentionLabel('max.mustermann', 'mm@dornig.de')).toBe('Max');
  });

  it('keeps the whole mailbox name when the first name is a bare initial', () => {
    expect(mentionLabel(undefined, 'm.mustermann@dornig.de')).toBe('m.mustermann');
    expect(mentionLabel(undefined, 'm.mustermann+news@dornig.de')).toBe('m.mustermann');
    expect(mentionLabel('M. Mustermann', 'm.mustermann@dornig.de')).toBe('m.mustermann');
    // The address may know more than the display name.
    expect(mentionLabel('M. Mustermann', 'max.mustermann@dornig.de')).toBe('Max');
  });

  it('stays fast on a crafted display name from an incoming message', () => {
    // Uncapped, trimming this token takes seconds (quadratic backtracking).
    const crafted = `a${'!'.repeat(100_000)}b`;
    const started = performance.now();
    expect(mentionLabel(crafted, 'max.mustermann@dornig.de')).toBe('Max');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('buildMentionCandidates', () => {
  it('offers To and Cc recipients in order, each address once', () => {
    const candidates = buildMentionCandidates(
      [{ name: 'Max Mustermann', email: 'max.mustermann@dornig.de' }, { email: 'anna.schmidt@dornig.de' }],
      [{ email: 'MAX.MUSTERMANN@dornig.de' }, { name: 'Eva Weber', email: 'eva.weber@dornig.de' }],
    );
    expect(candidates).toEqual([
      { label: 'Max', name: 'Max Mustermann', email: 'max.mustermann@dornig.de' },
      { label: 'Anna', name: undefined, email: 'anna.schmidt@dornig.de' },
      { label: 'Eva', name: 'Eva Weber', email: 'eva.weber@dornig.de' },
    ]);
  });

  it('expands contact groups into their members and skips entries without an address', () => {
    const candidates = buildMentionCandidates(
      [{
        name: 'Team',
        email: '',
        group: { members: [{ name: 'Max Mustermann', email: 'max.mustermann@dornig.de' }, { email: 'eva.weber@dornig.de' }] },
      }],
      [{ email: 'not-an-address' }],
    );
    expect(candidates.map((c) => c.label)).toEqual(['Max', 'Eva']);
  });

  it('tells apart recipients who would share a first name', () => {
    const labels = (to: Array<{ name?: string; email: string }>) => buildMentionCandidates(to, []).map((c) => c.label);
    expect(labels([
      { name: 'Max Mustermann', email: 'a@dornig.de' },
      { name: 'Mueller, Max', email: 'b@dornig.de' },
      { name: 'Eva Weber', email: 'c@dornig.de' },
    ])).toEqual(['Max Mustermann', 'Max Mueller', 'Eva']);
    expect(labels([
      { name: 'Max Mustermann', email: 'max.mustermann@dornig.de' },
      { email: 'max.mueller@dornig.de' },
    ])).toEqual(['Max Mustermann', 'max.mueller']);
    expect(labels([
      { name: 'Max Mustermann', email: 'max.mustermann@dornig.de' },
      { name: 'Max Mustermann', email: 'max.mustermann2@dornig.de' },
    ])).toEqual(['max.mustermann', 'max.mustermann2']);
  });
});

describe('filterMentionCandidates', () => {
  const candidates = buildMentionCandidates(
    [
      { name: 'Max Mustermann', email: 'max.mustermann@dornig.de' },
      { name: 'Jürgen Müller', email: 'juergen.mueller@dornig.de' },
      { email: 'anna-lena.schmidt@dornig.de' },
    ],
    [],
  );
  const labels = (query: string) => filterMentionCandidates(candidates, query).map((c) => c.label);

  it('offers everyone for a bare @', () => {
    expect(labels('')).toEqual(['Max', 'Jürgen', 'Anna-Lena']);
  });

  it('matches the start of the label, a name word or a mailbox part, ignoring case', () => {
    expect(labels('ma')).toEqual(['Max']);
    expect(labels('MUSTER')).toEqual(['Max']);
    expect(labels('lena')).toEqual(['Anna-Lena']);
    expect(labels('schm')).toEqual(['Anna-Lena']);
    expect(labels('xyz')).toEqual([]);
  });

  it('finds umlaut names typed either way', () => {
    expect(labels('jü')).toEqual(['Jürgen']);
    expect(labels('jue')).toEqual(['Jürgen']);
    expect(labels('mül')).toEqual(['Jürgen']);
  });
});
