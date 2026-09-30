import { describe, it, expect } from 'vitest';
import { acceptedFileName, fileNameProblem, fileNameRulesFrom } from '../file-name-rules';

// The filenode capability Stalwart 0.16.23 publishes.
const STALWART = fileNameRulesFrom({
  maxSizeFileNodeName: 255,
  forbiddenNameChars: '/<>:"\\|?*',
  forbiddenNodeNames: ['.', '..', 'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1'],
});

describe('file name rules', () => {
  it('has no rules for servers that publish none (Stalwart before 0.16.6)', () => {
    expect(fileNameRulesFrom({ maxSizeFileNodeName: 255 })).toBeNull();
    expect(fileNameProblem('a:b', null)).toBeNull();
    expect(acceptedFileName('a:b', null)).toBe('a:b');
  });

  it('reports forbidden characters and reserved names', () => {
    expect(fileNameProblem('bad:name?.txt', STALWART)).toEqual({ kind: 'chars', chars: ': ?' });
    expect(fileNameProblem('con', STALWART)).toEqual({ kind: 'reserved' });
    expect(fileNameProblem('CON.txt', STALWART)).toBeNull();
    expect(fileNameProblem('report.pdf', STALWART)).toBeNull();
  });

  it('turns an uploaded name into one the server accepts', () => {
    expect(acceptedFileName('bad:name?.txt', STALWART)).toBe('bad_name_.txt');
    expect(acceptedFileName('NUL', STALWART)).toBe('NUL_');
    expect(acceptedFileName('fine.txt', STALWART)).toBe('fine.txt');
  });
});
