// Pin TZ so the local-time date rendering in dateParts is deterministic.
process.env.TZ = 'UTC';

import { describe, it, expect } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import {
  emailExportFilename,
  attachmentDownloadFilename,
  bundleExportFilename,
  emailVars,
  attachmentVars,
  buildSampleEmail,
} from '@/lib/download-filename';

const makeEmail = (over: Partial<Email>): Email =>
  ({ id: 'e', receivedAt: '2026-05-22T14:05:33Z', from: [], to: [], subject: '', ...over } as unknown as Email);

describe('emailExportFilename', () => {
  it('renders the default template from the sample email (UTC)', () => {
    expect(emailExportFilename(buildSampleEmail())).toBe(
      '2026-05-22 14.05.33 (Alice Sender-Bob Recipient) Benachrichtigung von Ihrem Gerät.eml',
    );
  });

  it('applies lowercase + stripDiacritics + underscore-spaces transforms', () => {
    expect(
      emailExportFilename(buildSampleEmail(), {
        template: '{from_name}-{subject}',
        lowercase: true,
        stripDiacritics: true,
        spaceReplacement: 'underscore',
      }),
    ).toBe('alice_sender-benachrichtigung_von_ihrem_gerat.eml');
  });

  it('falls back to "no subject" for an empty subject', () => {
    expect(emailExportFilename(makeEmail({ subject: '' }), '{subject}')).toBe('no subject.eml');
  });

  it('falls back to "email" when the template renders empty', () => {
    expect(emailExportFilename(makeEmail({}), '{unknown_token}')).toBe('email.eml');
  });

  it('lets a single long token reach the 200-char filename cap', () => {
    // Each {token} is now capped at FILENAME_MAX_LEN (200), so the overall
    // filename limit governs instead of an earlier 80-char per-token cap.
    const out = emailExportFilename(makeEmail({ subject: 'a'.repeat(300) }), '{subject}');
    expect(out).toBe('a'.repeat(200) + '.eml');
  });
});

describe('attachmentDownloadFilename', () => {
  it('email===null: sanitises the raw attachment name, applying transforms', () => {
    expect(attachmentDownloadFilename(null, { name: 'Report.PDF' })).toBe('Report.PDF');
    expect(attachmentDownloadFilename(null, { name: 'Report.PDF' }, { lowercase: true })).toBe('report.pdf');
  });

  it('{filename} token preserves the original extension', () => {
    expect(
      attachmentDownloadFilename(buildSampleEmail(), { name: 'My Report.pdf' }, '{filename}'),
    ).toBe('My Report.pdf');
  });

  it('template without {ext}/{filename} appends the attachment extension', () => {
    expect(
      attachmentDownloadFilename(buildSampleEmail(), { name: 'My Report.PDF' }, '{name}'),
    ).toBe('My Report.PDF');
    expect(
      attachmentDownloadFilename(buildSampleEmail(), { name: 'My Report.PDF' }, { template: '{name}', lowercase: true }),
    ).toBe('my report.pdf');
  });

  it('attachment with no extension yields no trailing dot', () => {
    expect(attachmentDownloadFilename(buildSampleEmail(), { name: 'noext' }, '{name}')).toBe('noext');
  });

  it('sanitises path-traversal characters out of the name', () => {
    const out = attachmentDownloadFilename(null, { name: '../../etc/passwd' });
    expect(out).not.toContain('/');
    // CHARACTERISATION: slashes → "_", then the leading "._-" run is stripped,
    // so "../../etc/passwd" collapses to "etc_passwd".
    expect(out).toBe('etc_passwd');
  });
});

describe('bundleExportFilename', () => {
  it('substitutes {count} and appends .zip', () => {
    expect(bundleExportFilename(3, '{count}-emails', '2026-05-22T14:05:33Z')).toBe('3-emails.zip');
  });

  it('uses the default template', () => {
    expect(bundleExportFilename(5, {}, '2026-05-22T14:05:33Z')).toBe('emails-5.zip');
  });
});

describe('emailVars (date + address labels)', () => {
  it('returns the invalid-date sentinel for an unparseable date', () => {
    const v = emailVars(makeEmail({ receivedAt: 'not-a-date', sentAt: undefined }));
    expect(v.date).toBe('0000-00-00 00.00.00');
    expect(v.date_short).toBe('0000-00-00');
    expect(v.time).toBe('00.00.00');
    expect(v.year).toBe('0000');
  });

  it('addrLabel falls back name → email user-part → "unknown"', () => {
    expect(emailVars(makeEmail({ from: [{ email: 'alice@example.com' }] }) ).from).toBe('alice');
    expect(emailVars(makeEmail({ from: [] })).from).toBe('unknown');
    expect(emailVars(makeEmail({ from: [{ name: '   ', email: 'x@y.com' }] })).from).toBe('x');
  });
});

describe('attachmentVars (extension split)', () => {
  it('splits name and ext on the last dot', () => {
    const v = attachmentVars(buildSampleEmail(), { name: 'doc.tar.gz' });
    expect(v).toMatchObject({ filename: 'doc.tar.gz', name: 'doc.tar', ext: 'gz' });
  });

  it('treats a dotless name as having no extension', () => {
    const v = attachmentVars(buildSampleEmail(), { name: 'noext' });
    expect(v).toMatchObject({ name: 'noext', ext: '' });
  });

  it('defaults a missing name to "attachment"', () => {
    const v = attachmentVars(buildSampleEmail(), {});
    expect(v).toMatchObject({ filename: 'attachment', ext: '' });
  });
});
