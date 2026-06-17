import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { expandImportableEmails, EML_IMPORT_ACCEPT } from '@/lib/eml-import';

const emlFile = (name: string, content = 'raw email', type = 'message/rfc822') =>
  new File([content], name, { type });

describe('expandImportableEmails', () => {
  it('wraps a .eml file as a message/rfc822 blob, keeping its name', async () => {
    const out = await expandImportableEmails([emlFile('msg.eml')]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('msg.eml');
    expect(out[0].blob.type).toBe('message/rfc822');
    await expect(out[0].blob.text()).resolves.toBe('raw email');
  });

  it('CHARACTERISATION: wraps a non-.eml, non-zip file as rfc822 too', async () => {
    const out = await expandImportableEmails([emlFile('note.txt', 'hi', 'text/plain')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'note.txt' });
    expect(out[0].blob.type).toBe('message/rfc822');
  });

  it('extracts only .eml entries from a .zip, stripping path prefixes', async () => {
    const zip = new JSZip();
    zip.file('a.eml', 'A');
    zip.file('sub/b.eml', 'B');
    zip.file('c.txt', 'C'); // skipped (not .eml)
    zip.folder('emptydir'); // skipped (directory)
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'archive.zip', { type: 'application/zip' });

    const out = await expandImportableEmails([file]);
    expect(out.map((e) => e.name).sort()).toEqual(['a.eml', 'b.eml']);
    expect(out.every((e) => e.blob.type === 'message/rfc822')).toBe(true);
  });

  it('uses the zip path when the MIME type is application/zip even without a .zip name', async () => {
    const zip = new JSZip();
    zip.file('only.eml', 'X');
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'archive-no-ext', { type: 'application/zip' });

    const out = await expandImportableEmails([file]);
    expect(out.map((e) => e.name)).toEqual(['only.eml']);
  });

  it('exposes the accept string for the file picker', () => {
    expect(EML_IMPORT_ACCEPT).toBe('.eml,.zip,message/rfc822,application/zip');
  });
});
