import { describe, expect, it } from 'vitest';
import { spamApplicableIn } from '../spam-applicable';

describe('spamApplicableIn', () => {
  it('offers Report spam on received mail', () => {
    for (const role of ['inbox', 'archive', 'junk', null, undefined]) expect(spamApplicableIn(role)).toBe(true);
  });

  it('not on your own outgoing mail, nor in Trash', () => {
    for (const role of ['sent', 'drafts', 'scheduled', 'trash']) expect(spamApplicableIn(role)).toBe(false);
  });
});
