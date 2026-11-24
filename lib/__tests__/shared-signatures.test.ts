import { describe, expect, it } from 'vitest';
import type { Identity } from '@/lib/jmap/types';
import { identitiesUsingSignatureOf, setSignatureSource, signatureFieldsOf, signatureSourceOf } from '../shared-signatures';

// #1190: which address's signature an address uses, kept per login.

const id = (key: string): Identity => ({ id: key, name: key, email: `${key}@example.com`, mayDelete: true });
const all = [id('a'), id('b'), id('c'), id('d')];

describe('shared signatures', () => {
  it('links an address to another and back', () => {
    const linked = setSignatureSource({}, 'login', 'b', 'a');
    expect(linked).toEqual({ login: { b: 'a' } });
    expect(signatureSourceOf(linked, 'login', 'b', all)?.id).toBe('a');
    expect(signatureSourceOf(linked, 'login', 'a', all)).toBeNull();
    expect(setSignatureSource(linked, 'login', 'b', null)).toEqual({});
  });

  it('keeps every login apart', () => {
    const map = setSignatureSource({ other: { c: 'd' } }, 'login', 'b', 'a');
    expect(map).toEqual({ other: { c: 'd' }, login: { b: 'a' } });
    expect(signatureSourceOf(map, 'other', 'b', all)).toBeNull();
  });

  it('never chains: linking to an address that uses another takes that one', () => {
    const map = setSignatureSource({ login: { b: 'a' } }, 'login', 'c', 'b');
    expect(map.login).toEqual({ b: 'a', c: 'a' });
  });

  it('moves the addresses using this one along when it uses another', () => {
    const map = setSignatureSource({ login: { b: 'a', c: 'a' } }, 'login', 'a', 'd');
    expect(map.login).toEqual({ a: 'd', b: 'd', c: 'd' });
  });

  it('turns a link around instead of making a loop', () => {
    const map = setSignatureSource({ login: { b: 'a', c: 'a' } }, 'login', 'a', 'b');
    expect(map.login).toEqual({ a: 'b', c: 'b' });
  });

  it('lists the addresses using a signature', () => {
    const map = { login: { b: 'a', c: 'a', d: 'b' } };
    expect(identitiesUsingSignatureOf(map, 'login', 'a', all).map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('uses its own signature when the other address is gone or the link is broken', () => {
    expect(signatureSourceOf({ login: { b: 'gone' } }, 'login', 'b', all)).toBeNull();
    expect(signatureSourceOf({ login: 'junk' } as never, 'login', 'b', all)).toBeNull();
    expect(signatureSourceOf({ login: { b: 'b' } }, 'login', 'b', all)).toBeNull();
  });

  it('clears an empty signature field with null, as JMAP does', () => {
    expect(signatureFieldsOf({ htmlSignature: '  ', textSignature: 'Sam' })).toEqual({ htmlSignature: null, textSignature: 'Sam' });
  });
});
