import { describe, expect, it } from 'vitest';
import { isSmimeEmail } from '../jmap/client';
import type { Email } from '../jmap/types';

// A scheduled message counts as S/MIME only when it is S/MIME as a whole.
// "Cancel and edit" deletes such a message and opens an empty composer,
// because a signed or encrypted message can't come back as a draft; an
// ordinary message with a pkcs7 attachment has to come back with its text.

type Part = NonNullable<Email['bodyStructure']>;
const part = (type: string, subParts?: Part[], name?: string): Part => ({ type, ...(subParts ? { subParts } : {}), ...(name ? { name } : {}) }) as Part;
const mail = (bodyStructure: Part | undefined, attachments: Array<{ type: string; name?: string }> = []) =>
  ({ bodyStructure, attachments }) as unknown as Email;

const text = part('text/plain');
const body = part('multipart/alternative', [text, part('text/html')]);

describe('an S/MIME message', () => {
  it.each([
    ['application/pkcs7-mime'],
    ['application/x-pkcs7-mime'],
    ['Application/PKCS7-MIME'],
    ['application/pkcs7-mime; smime-type=enveloped-data'],
  ])('is one whose own type is %s', (type) => {
    expect(isSmimeEmail(mail(part(type), [{ type: 'application/pkcs7-mime', name: 'smime.p7m' }]))).toBe(true);
  });

  it.each([
    ['application/pkcs7-signature'],
    ['application/x-pkcs7-signature'],
  ])('is multipart/signed with a %s part', (type) => {
    expect(isSmimeEmail(mail(part('multipart/signed', [body, part(type, undefined, 'smime.p7s')])))).toBe(true);
  });

  it('is one with the signed part further down, as a list or gateway wraps it', () => {
    const signed = part('multipart/signed', [body, part('application/pkcs7-signature')]);
    expect(isSmimeEmail(mail(part('multipart/mixed', [signed, part('text/plain')])))).toBe(true);
  });

  it('is one the server gave no body structure for, when all it lists is pkcs7-mime', () => {
    expect(isSmimeEmail(mail(undefined, [{ type: 'application/pkcs7-mime', name: 'smime.p7m' }]))).toBe(true);
    expect(isSmimeEmail(mail(undefined, [{ type: 'application/x-pkcs7-mime' }]))).toBe(true);
  });
});

describe('an ordinary message', () => {
  it.each([
    ['a certificate chain', 'application/x-pkcs7-certificates', 'chain.p7b'],
    ['the signature file of a forwarded signed message', 'application/pkcs7-signature', 'smime.p7s'],
    ['an encrypted file sent along', 'application/pkcs7-mime', 'report.p7m'],
    ['a file of the old type', 'application/x-pkcs7-signature', 'old.p7s'],
  ])('stays one with %s attached', (_label, type, name) => {
    const structure = part('multipart/mixed', [body, part(type, undefined, name)]);
    expect(isSmimeEmail(mail(structure, [{ type, name }]))).toBe(false);
  });

  it('stays one without attachments', () => {
    expect(isSmimeEmail(mail(text))).toBe(false);
    expect(isSmimeEmail(mail(body))).toBe(false);
  });

  it('stays one with a pkcs7 signature part outside any multipart/signed', () => {
    const structure = part('multipart/mixed', [part('multipart/related', [body, part('application/pkcs7-signature')])]);
    expect(isSmimeEmail(mail(structure))).toBe(false);
  });

  it('stays one when multipart/signed holds another kind of signature', () => {
    expect(isSmimeEmail(mail(part('multipart/signed', [body, part('application/pgp-signature')])))).toBe(false);
  });

  it('stays one when the signature sits a level below multipart/signed', () => {
    const structure = part('multipart/signed', [part('multipart/mixed', [body, part('application/pkcs7-signature')]), part('application/pgp-signature')]);
    expect(isSmimeEmail(mail(structure))).toBe(false);
  });

  it('stays one without a body structure when not everything listed is pkcs7-mime', () => {
    expect(isSmimeEmail(mail(undefined, []))).toBe(false);
    expect(isSmimeEmail(mail(undefined, [{ type: 'application/pdf' }]))).toBe(false);
    expect(isSmimeEmail(mail(undefined, [{ type: 'application/pkcs7-mime' }, { type: 'application/pdf' }]))).toBe(false);
    expect(isSmimeEmail(mail(undefined, [{ type: 'application/pkcs7-signature', name: 'smime.p7s' }]))).toBe(false);
  });
});
