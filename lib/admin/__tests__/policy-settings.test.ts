import { describe, expect, it } from 'vitest';
import { sanitizePolicyDefaults } from '../policy-settings';

describe('sanitizePolicyDefaults', () => {
  it('keeps valid defaults for governable settings', () => {
    expect(sanitizePolicyDefaults({
      signaturePosition: 'above_quote',
      sendConfirmation: true,
      emailsPerPage: 50,
      markAsReadDelay: -1,
      sessionTimeout: 30,
    })).toEqual({
      signaturePosition: 'above_quote',
      sendConfirmation: true,
      emailsPerPage: 50,
      markAsReadDelay: -1,
      sessionTimeout: 30,
    });
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

  it('only accepts the values the settings UI itself offers for numeric pickers', () => {
    expect(sanitizePolicyDefaults({ emailsPerPage: 0 })).toEqual({});
    expect(sanitizePolicyDefaults({ emailsPerPage: -25 })).toEqual({});
    expect(sanitizePolicyDefaults({ emailsPerPage: 30 })).toEqual({});
    expect(sanitizePolicyDefaults({ emailsPerPage: '25' })).toEqual({});
    expect(sanitizePolicyDefaults({ markAsReadDelay: 1000 })).toEqual({});
  });

  it('bounds free numbers and requires integers', () => {
    expect(sanitizePolicyDefaults({ sessionTimeout: -1 })).toEqual({});
    expect(sanitizePolicyDefaults({ sessionTimeout: 1.5 })).toEqual({});
    expect(sanitizePolicyDefaults({ sessionTimeout: 0 })).toEqual({ sessionTimeout: 0 });
  });

  it('tolerates a missing or malformed defaults section', () => {
    expect(sanitizePolicyDefaults(undefined)).toEqual({});
    expect(sanitizePolicyDefaults(null)).toEqual({});
    expect(sanitizePolicyDefaults(['above_quote'])).toEqual({});
    expect(sanitizePolicyDefaults('above_quote')).toEqual({});
  });
});
