import { describe, it, expect } from 'vitest';
import { splitAttachmentName } from '@/lib/attachment-name';
import { plainFileNameProblem } from '@/lib/file-name-rules';
import { renamedAttachmentFilename } from '@/lib/download-filename';

// Renaming an attachment edits the part before the extension; the extension
// stays, so the file keeps its type.

describe('splitAttachmentName', () => {
  it.each([
    ['report.pdf', 'report', '.pdf'],
    // Only the last extension is fixed.
    ['archive.tar.gz', 'archive.tar', '.gz'],
    ['README', 'README', ''],
    // A leading dot starts the name, it is no extension.
    ['.bashrc', '.bashrc', ''],
    // Nothing after the dot: no extension to keep.
    ['name.', 'name.', ''],
  ])('%s → %s + %s', (name, stem, ext) => {
    expect(splitAttachmentName(name)).toEqual([stem, ext]);
  });
});

describe('plainFileNameProblem', () => {
  it('takes an ordinary name', () => {
    expect(plainFileNameProblem('Q3 report (final).pdf')).toBeNull();
  });

  it.each(['a/b.pdf', 'a\\b.pdf'])('refuses a path separator in %s', (name) => {
    expect(plainFileNameProblem(name)?.kind).toBe('chars');
  });

  it('refuses a control character', () => {
    expect(plainFileNameProblem('a\u0007b.pdf')?.kind).toBe('control');
  });

  it('refuses more than 255 characters, and takes 255', () => {
    expect(plainFileNameProblem(`${'a'.repeat(252)}.pdf`)?.kind).toBe('tooLong');
    expect(plainFileNameProblem(`${'a'.repeat(251)}.pdf`)).toBeNull();
  });
});

describe('renamedAttachmentFilename', () => {
  it('keeps the name as typed: case, spaces and punctuation', () => {
    expect(renamedAttachmentFilename('Q3 Report — Final ü.pdf')).toBe('Q3 Report — Final ü.pdf');
  });

  it('replaces what a file system cannot take', () => {
    expect(renamedAttachmentFilename('a:b?c*.pdf')).toBe('a_b_c_.pdf');
  });

  it('drops directional overrides', () => {
    expect(renamedAttachmentFilename('report‮fdp.exe')).toBe('reportfdp.exe');
  });
});
