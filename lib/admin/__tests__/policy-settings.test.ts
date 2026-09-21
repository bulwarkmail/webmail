import { describe, expect, it } from 'vitest';
import { sanitizePolicyDefaults } from '../policy-settings';

describe('sanitizePolicyDefaults', () => {
  it('keeps valid defaults for governable settings', () => {
    expect(sanitizePolicyDefaults({
      signaturePosition: 'above_quote',
      sendConfirmation: true,
      emailsPerPage: 50,
    })).toEqual({ signaturePosition: 'above_quote', sendConfirmation: true, emailsPerPage: 50 });
  });

  it('drops unknown keys and values of the wrong shape', () => {
    expect(sanitizePolicyDefaults({
      signaturePosition: 'sideways',
      sendConfirmation: 'yes',
      emailsPerPage: Number.NaN,
      folderIcons: { a: 'b' },
      updateSetting: 'x',
    })).toEqual({});
  });

  it('tolerates a missing or malformed defaults section', () => {
    expect(sanitizePolicyDefaults(undefined)).toEqual({});
    expect(sanitizePolicyDefaults(null)).toEqual({});
    expect(sanitizePolicyDefaults(['above_quote'])).toEqual({});
    expect(sanitizePolicyDefaults('above_quote')).toEqual({});
  });
});
