import { describe, it, expect } from 'vitest';
import { buildContactNameResolver } from '../use-contact-name-resolver';
import type { ContactCard } from '@/lib/jmap/types';

/**
 * The resolver backs participant rendering (#738): a bare address in the
 * event data must display the contact card's name (e.g. its 备注 name), while
 * names already carried by the event stay authoritative — the resolver only
 * ever fills, never replaces.
 */

function makeContact(
  emails: string[],
  name?: string,
  overrides: Partial<ContactCard> = {}
): ContactCard {
  return {
    id: Math.random().toString(36).slice(2),
    addressBookIds: { ab1: true },
    emails: Object.fromEntries(
      emails.map((address, i) => [`${i}`, { address }])
    ),
    ...(name ? { name: { full: name } } : {}),
    ...overrides,
  } as ContactCard;
}

describe('buildContactNameResolver', () => {
  it('maps every address of a contact to its display name', () => {
    const resolver = buildContactNameResolver([
      makeContact(['alice@example.com', 'alice.smith@example.com'], '爱丽丝'),
    ]);
    expect(resolver('alice@example.com')).toBe('爱丽丝');
    expect(resolver('alice.smith@example.com')).toBe('爱丽丝');
  });

  it('matches addresses case-insensitively and trims whitespace', () => {
    const resolver = buildContactNameResolver([makeContact(['alice@example.com'], 'Alice')]);
    expect(resolver('ALICE@EXAMPLE.COM')).toBe('Alice');
    expect(resolver('  alice@example.com  ')).toBe('Alice');
  });

  it('keeps the first contact when several hold the same address', () => {
    const resolver = buildContactNameResolver([
      makeContact(['bob@example.com'], 'First Bob'),
      makeContact(['bob@example.com'], 'Second Bob'),
    ]);
    expect(resolver('bob@example.com')).toBe('First Bob');
  });

  it('prefers name components over name.full, like getContactDisplayName', () => {
    const resolver = buildContactNameResolver([
      makeContact(['carol@example.com'], undefined, {
        name: {
          components: [
            { kind: 'given', value: '王' },
            { kind: 'surname', value: '小' },
          ],
          isOrdered: true,
        },
      }),
    ]);
    expect(resolver('carol@example.com')).toBe('王 小');
  });

  it('skips contacts without a resolvable name', () => {
    const resolver = buildContactNameResolver([
      makeContact(['noname@example.com']), // only an email on the card
    ]);
    expect(resolver('noname@example.com')).toBeUndefined();
  });

  it('returns undefined for unknown or blank addresses', () => {
    const resolver = buildContactNameResolver([makeContact(['alice@example.com'], 'Alice')]);
    expect(resolver('unknown@example.com')).toBeUndefined();
    expect(resolver('')).toBeUndefined();
    expect(resolver('   ')).toBeUndefined();
  });

  it('handles an empty contact list', () => {
    const resolver = buildContactNameResolver([]);
    expect(resolver('alice@example.com')).toBeUndefined();
  });

  it('ignores blank addresses on cards', () => {
    const resolver = buildContactNameResolver([
      makeContact(['alice@example.com'], 'Alice'),
      makeContact(['   '], 'Blank'),
    ]);
    expect(resolver('alice@example.com')).toBe('Alice');
  });
});
