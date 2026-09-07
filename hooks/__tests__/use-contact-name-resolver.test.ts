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

describe('buildContactNameResolver — related-domain fallback', () => {
  // #738: the event stores the organizer as zhang@node-example.com (the
  // account's node domain) while the contact card with the 备注 name carries
  // zhang@example.com — same person, different domain.
  it('resolves an address whose local part matches a card on a related domain', () => {
    const resolver = buildContactNameResolver([
      makeContact(['zhang@example.com'], '张三'),
    ]);
    expect(resolver('zhang@node-example.com')).toBe('张三');
  });

  it('resolves subdomain-related domains (mail.example.com vs example.com)', () => {
    const resolver = buildContactNameResolver([
      makeContact(['bob@example.com'], 'Bob'),
    ]);
    expect(resolver('bob@mail.example.com')).toBe('Bob');
  });

  it('works in the other direction too (card on the longer domain)', () => {
    const resolver = buildContactNameResolver([
      makeContact(['carol@node-example.com'], 'Carol'),
    ]);
    expect(resolver('carol@example.com')).toBe('Carol');
  });

  it('does NOT fall back across unrelated domains', () => {
    const resolver = buildContactNameResolver([
      makeContact(['john@company.com'], 'John'),
    ]);
    expect(resolver('john@gmail.com')).toBeUndefined();
  });

  it('does NOT treat a plain string-suffix domain as related', () => {
    // "xexample.com" ends with "example.com" but the split char is "x", not a
    // "." or "-" label boundary — different registrable domain.
    const resolver = buildContactNameResolver([
      makeContact(['dave@example.com'], 'Dave'),
    ]);
    expect(resolver('dave@xexample.com')).toBeUndefined();
  });

  it('returns nothing when two related-domain cards disagree on the name', () => {
    // x.mail.example.com is related to both example.com and mail.example.com,
    // and the two cards disagree — guessing would be worse than showing the
    // bare address.
    const resolver = buildContactNameResolver([
      makeContact(['eve@example.com'], 'Eve One'),
      makeContact(['eve@mail.example.com'], 'Eve Two'),
    ]);
    expect(resolver('eve@x.mail.example.com')).toBeUndefined();
  });

  it('resolves when two related-domain cards agree on the name', () => {
    const resolver = buildContactNameResolver([
      makeContact(['eve@example.com'], 'Eve'),
      makeContact(['eve@mail.example.com'], 'Eve'),
    ]);
    expect(resolver('eve@x.mail.example.com')).toBe('Eve');
  });
});

describe('buildContactNameResolver — account and identity layers', () => {
  // The organizer of a self-created event is the user; Stalwart strips the
  // participant name, so the user's own name has to come from the account
  // (live principal name) or the identity (From-name snapshot).
  it('resolves the account display name for the account address', () => {
    const resolver = buildContactNameResolver(
      [],
      [],
      [{ name: '张三', email: 'zhang@node-example.com', username: 'zhang' }]
    );
    expect(resolver('zhang@node-example.com')).toBe('张三');
  });

  it('matches the account username when it is a full address', () => {
    const resolver = buildContactNameResolver(
      [],
      [],
      [{ name: '张三', email: undefined, username: 'zhang@node-example.com' }]
    );
    expect(resolver('zhang@node-example.com')).toBe('张三');
  });

  it('ignores short login usernames that are not addresses', () => {
    const resolver = buildContactNameResolver(
      [],
      [],
      [{ name: '张三', email: undefined, username: 'zhang' }]
    );
    expect(resolver('zhang@node-example.com')).toBeUndefined();
  });

  it('skips account names that are just the address itself', () => {
    const resolver = buildContactNameResolver(
      [],
      [],
      [{ name: 'zhang@node-example.com', email: 'zhang@node-example.com' }]
    );
    expect(resolver('zhang@node-example.com')).toBeUndefined();
  });

  it('resolves the identity From-name when the account has nothing', () => {
    const resolver = buildContactNameResolver(
      [],
      [{ name: '张三', email: 'zhang@node-example.com' }],
      []
    );
    expect(resolver('zhang@node-example.com')).toBe('张三');
  });

  it('prefers the account name over the identity snapshot', () => {
    // On Stalwart the identity name is a one-time snapshot; the account name
    // is refreshed from the principal, so it is the more current source.
    const resolver = buildContactNameResolver(
      [],
      [{ name: 'Old Name', email: 'zhang@node-example.com' }],
      [{ name: 'New Name', email: 'zhang@node-example.com' }]
    );
    expect(resolver('zhang@node-example.com')).toBe('New Name');
  });

  it('ranks a related-domain contact card above the account name', () => {
    // The 备注 the user curated on the card beats a server-side default.
    const resolver = buildContactNameResolver(
      [makeContact(['zhang@example.com'], '卡片备注名')],
      [],
      [{ name: '账号名', email: 'zhang@node-example.com' }]
    );
    expect(resolver('zhang@node-example.com')).toBe('卡片备注名');
  });

  it('ranks an exact contact card above everything else', () => {
    const resolver = buildContactNameResolver(
      [makeContact(['zhang@node-example.com'], '精确卡片名')],
      [{ name: 'Identity Name', email: 'zhang@node-example.com' }],
      [{ name: 'Account Name', email: 'zhang@node-example.com' }]
    );
    expect(resolver('zhang@node-example.com')).toBe('精确卡片名');
  });

  it('resolves the exact card even when it also matches account data', () => {
    const resolver = buildContactNameResolver(
      [makeContact(['alice@example.com'], '爱丽丝')],
      [{ name: 'Alice Identity', email: 'alice@example.com' }],
      []
    );
    expect(resolver('alice@example.com')).toBe('爱丽丝');
  });
});
