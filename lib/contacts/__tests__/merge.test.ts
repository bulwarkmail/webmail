import { describe, expect, it } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';
import { findDuplicateGroups, memberKeys, planGroupMoves, planMerge } from '../merge';

const card = (id: string, extra: Partial<ContactCard>): ContactCard => ({ id, addressBookIds: { b1: true }, ...extra });
const named = (given: string, surname: string) => ({
  components: [{ kind: 'given' as const, value: given }, { kind: 'surname' as const, value: surname }], isOrdered: true,
});

// A structured German address as the server sends it: it must reach the
// merged card exactly as it is, parts and order.
const BERLIN = {
  components: [
    { kind: 'name', value: 'Hauptstraße' }, { kind: 'separator', value: ' ' }, { kind: 'number', value: '1' },
    { kind: 'postcode', value: '10115' }, { kind: 'locality', value: 'Berlin' }, { kind: 'country', value: 'Germany' },
  ],
  isOrdered: true,
  defaultSeparator: ', ',
  contexts: { private: true },
};

describe('findDuplicateGroups', () => {
  it('groups by name (any order, case, accents), e-mail or phone, and only within one account', () => {
    const anna1 = card('a1', { name: named('Anna', 'Müller'), emails: { e0: { address: 'anna@example.net' } } });
    const anna2 = card('a2', { name: { full: 'muller anna' } });
    const annaMail = card('a3', { emails: { x: { address: 'ANNA@example.net' } } });
    const ben1 = card('b1', { name: named('Ben', 'One'), phones: { p: { number: '+49 30 5550000' } } });
    const ben2 = card('b2', { name: named('Benjamin', 'Two'), phones: { p: { number: '030 5550000' } } });
    const other = card('o', { name: named('Anna', 'Müller'), localAccountId: 'second' });
    const lone = card('l', { name: named('Lone', 'Person'), emails: { e: { address: 'lone@example.net' } } });
    const group = card('g', { kind: 'group', name: { full: 'Anna Müller' } });

    const groups = findDuplicateGroups([anna1, anna2, annaMail, ben1, ben2, other, lone, group]);
    expect(groups.map((g) => g.map((c) => c.id))).toEqual([['a1', 'a2', 'a3'], ['b1', 'b2']]);
  });

  it('does not match on empty or very short names', () => {
    expect(findDuplicateGroups([card('1', { name: { full: 'A' } }), card('2', { name: { full: 'a' } })])).toEqual([]);
  });
});

describe('planMerge', () => {
  const older = card('old', {
    uid: 'urn:uuid:old',
    updated: '2026-01-01T00:00:00Z',
    name: named('Anna', 'Example'),
    emails: { e0: { address: 'anna@example.net', pref: 1 }, e1: { address: 'anna@home.example.net', contexts: { private: true } } },
    phones: { p0: { number: '+49 30 550000' } },
    addresses: { a0: structuredClone(BERLIN) },
    organizations: { o0: { name: 'Example GmbH' } },
    titles: { t0: { name: 'Project manager', kind: 'title', organizationId: 'o0' } },
    notes: { n0: { note: 'Met at the fair' } },
    language: 'de',
    keywords: { Clients: true },
    anniversaries: { a0: { kind: 'birth', date: { year: 1970, month: 1, day: 1 } } },
  });
  const newer = card('new', {
    uid: 'urn:uuid:new',
    updated: '2026-06-01T00:00:00Z',
    name: named('Anna', 'Example-Neu'),
    emails: { e0: { address: 'ANNA@example.net' }, e1: { address: 'anna.work@example.net', contexts: { work: true }, pref: 1 } },
    phones: { p0: { number: '030 550000' }, p1: { number: '+49 170 9000000', features: { mobile: true } } },
    organizations: { o0: { name: 'Other AG' } },
    titles: { t0: { name: 'Advisor', kind: 'title', organizationId: 'o0' } },
    keywords: { VIP: true },
  });

  it('keeps the newer card and adds what only the older one has, without repeats', () => {
    const plan = planMerge([older, newer]);
    expect(plan.keep.id).toBe('new');
    expect(plan.others.map((c) => c.id)).toEqual(['old']);
    const r = plan.result;
    // The newer name wins.
    expect(r.name).toEqual(newer.name);
    expect(Object.values(r.emails ?? {}).map((e) => e.address)).toEqual(['ANNA@example.net', 'anna.work@example.net', 'anna@home.example.net']);
    // The added address has no second "preferred".
    expect(r.emails?.e1m1).toEqual({ address: 'anna@home.example.net', contexts: { private: true } });
    expect(Object.values(r.phones ?? {}).map((p) => p.number)).toEqual(['030 550000', '+49 170 9000000']);
    // The address arrives exactly as it was, parts and order.
    expect(Object.values(r.addresses ?? {})).toEqual([BERLIN]);
    expect(Object.values(r.notes ?? {})).toEqual([{ note: 'Met at the fair' }]);
    expect(r.organizations).toEqual({ o0: { name: 'Other AG' }, o0m1: { name: 'Example GmbH' } });
    // The older title still points at its own organisation under its new key.
    expect(r.titles).toEqual({
      t0: { name: 'Advisor', kind: 'title', organizationId: 'o0' },
      t0m1: { name: 'Project manager', kind: 'title', organizationId: 'o0m1' },
    });
    expect(r.language).toBe('de');
    expect(r.keywords).toEqual({ VIP: true, Clients: true });
    expect(r.anniversaries).toEqual(older.anniversaries);
    expect(r.uid).toBe('urn:uuid:new');
  });

  it('patches only what changes, and leaves the kept entries untouched', () => {
    const plan = planMerge([older, newer]);
    expect(Object.keys(plan.patch).sort()).toEqual(
      ['addresses', 'anniversaries', 'emails', 'keywords', 'language', 'notes', 'organizations', 'titles'],
    );
    expect(plan.patch.emails?.e0).toEqual(newer.emails!.e0);
    expect(plan.patch.emails?.e1).toEqual(newer.emails!.e1);
    expect(plan.patch).not.toHaveProperty('name');
    // The inputs are not changed.
    expect(Object.keys(newer.emails!)).toEqual(['e0', 'e1']);
  });

  it('keeps the first card when none says when it changed, and fills an empty name from the others', () => {
    const emailOnly = card('x', { emails: { e: { address: 'ben@example.net' } } });
    const namedBen = card('y', { name: named('Ben', 'Muster'), emails: { e: { address: 'ben@example.net' } } });
    const plan = planMerge([emailOnly, namedBen]);
    expect(plan.keep.id).toBe('x');
    expect(plan.result.name).toEqual(namedBen.name);
    expect(Object.keys(plan.patch)).toEqual(['name']);
  });

  it('takes a photo only when the kept card has none', () => {
    const withPhoto = card('p', { media: { m0: { kind: 'photo', uri: 'data:image/png;base64,AA==' } } });
    const without = card('q', { updated: '2026-06-01T00:00:00Z' });
    expect(planMerge([withPhoto, without]).patch.media).toEqual({ m0: { kind: 'photo', uri: 'data:image/png;base64,AA==' } });
    const both = card('r', { updated: '2026-06-01T00:00:00Z', media: { m0: { kind: 'photo', uri: 'data:image/png;base64,BB==' } } });
    expect(planMerge([withPhoto, both]).patch).not.toHaveProperty('media');
  });
});

describe('planGroupMoves', () => {
  it('moves the merged cards\' memberships to the kept card', () => {
    const keep = card('k', { uid: 'urn:uuid:keep' });
    const gone = card('g1', { uid: 'urn:uuid:gone' });
    const team = card('team', { kind: 'group', members: { 'urn:uuid:gone': true, 'urn:uuid:x': true } });
    const both = card('both', { kind: 'group', members: { 'urn:uuid:gone': true, 'urn:uuid:keep': true } });
    const bare = card('bare', { kind: 'group', members: { gone: true } });
    const unrelated = card('u', { kind: 'group', members: { 'urn:uuid:x': true } });
    const moves = planGroupMoves([team, both, bare, unrelated], keep, [gone]);
    expect(moves.map((m) => [m.group.id, m.members])).toEqual([
      ['team', { 'urn:uuid:x': true, 'urn:uuid:keep': true }],
      ['both', { 'urn:uuid:keep': true }],
      ['bare', { 'urn:uuid:keep': true }],
    ]);
  });

  it('knows a card under its uid with and without urn:uuid:', () => {
    expect(memberKeys(card('id1', { uid: 'urn:uuid:abc', originalId: 'raw' }))).toEqual(['urn:uuid:abc', 'abc', 'raw', 'id1']);
  });
});
