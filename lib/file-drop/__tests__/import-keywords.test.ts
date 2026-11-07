import { describe, expect, it } from 'vitest';
import { importKeywords } from '../import-keywords';

// #1535: an .eml imported into Drafts had no $draft keyword, so it showed
// as a received message that could be neither edited nor sent.
describe('importKeywords', () => {
  it('marks a message imported into Drafts as a draft', () => {
    expect(importKeywords('drafts')).toEqual({ $seen: true, $draft: true });
  });

  it('imports into any other folder as a read message', () => {
    for (const role of ['inbox', 'archive', 'sent', null, undefined]) {
      expect(importKeywords(role)).toEqual({ $seen: true });
    }
  });
});
