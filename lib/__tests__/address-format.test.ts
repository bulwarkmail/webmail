import { describe, it, expect } from 'vitest';
import {
  addressStyle,
  addressToParts,
  countryCodeFromName,
  formatAddressLines,
  partsToComponents,
  splitStreet,
} from '../address-format';
import type { ContactAddress } from '@/lib/jmap/types';

const german: ContactAddress = {
  components: [
    { kind: 'name', value: 'Hauptstraße' },
    { kind: 'number', value: '1' },
    { kind: 'postcode', value: '10000' },
    { kind: 'locality', value: 'Berlin' },
    { kind: 'country', value: 'Germany' },
  ],
};

describe('address-format', () => {
  it('knows countries by code and by name in several languages', () => {
    expect(countryCodeFromName('Germany')).toBe('DE');
    expect(countryCodeFromName('Deutschland')).toBe('DE');
    expect(countryCodeFromName('Schweiz')).toBe('CH');
    expect(countryCodeFromName('de')).toBe('DE');
    expect(countryCodeFromName('USA')).toBe('US');
    expect(countryCodeFromName('United Kingdom')).toBe('GB');
    expect(countryCodeFromName('Atlantis')).toBeNull();
  });

  it('puts the number after the street for Germany and before it for the US', () => {
    expect(addressStyle('Germany').street).toBe('number-after');
    expect(addressStyle('Österreich').street).toBe('number-after');
    expect(addressStyle('Netherlands').street).toBe('number-after');
    expect(addressStyle('United States').street).toBe('number-before');
    expect(addressStyle('France')).toEqual({ street: 'number-before', town: 'postcode-city' });
    expect(addressStyle('', 'CA').town).toBe('city-region-postcode');
    // No country: the UI language's.
    expect(addressStyle('', null, 'de').street).toBe('number-after');
    expect(addressStyle('', null, 'en').street).toBe('number-before');
  });

  it('shows street and number in one field in the country\'s order', () => {
    expect(addressToParts(german).street).toBe('Hauptstraße 1');
    expect(addressToParts({ ...german, countryCode: 'US', components: [
      { kind: 'number', value: '1' }, { kind: 'name', value: 'Main Street' }, { kind: 'country', value: 'USA' },
    ] }).street).toBe('1 Main Street');
    // A country this file doesn't know keeps the card's own order.
    expect(addressToParts({ components: [
      { kind: 'name', value: 'Ulitsa' }, { kind: 'number', value: '7' }, { kind: 'country', value: 'Atlantis' },
    ] }).street).toBe('Ulitsa 7');
  });

  it('splits a typed street line where the country puts the number', () => {
    expect(splitStreet('Hauptstraße 12a', 'number-after')).toEqual({ name: 'Hauptstraße', number: '12a' });
    expect(splitStreet('Am Markt 3-5', 'number-after')).toEqual({ name: 'Am Markt', number: '3-5' });
    expect(splitStreet('Am Markt', 'number-after')).toEqual({ name: 'Am Markt', number: '' });
    expect(splitStreet('221B Baker Street', 'number-before')).toEqual({ name: 'Baker Street', number: '221B' });
    expect(splitStreet('Baker Street 221', 'number-before')).toEqual({ name: 'Baker Street 221', number: '' });
  });

  it('builds components in the country\'s order, keeping parts the form doesn\'t show', () => {
    const parts = { street: 'Hauptstraße 1', locality: 'Berlin', region: '', postcode: '10000', country: 'Germany' };
    const components = partsToComponents(parts, [{ kind: 'apartment', value: '3. OG' }]);
    expect(components.map(c => `${c.kind}:${c.value}`)).toEqual([
      'name:Hauptstraße', 'separator: ', 'number:1', 'apartment:3. OG', 'postcode:10000', 'separator: ', 'locality:Berlin', 'country:Germany',
    ]);
    const us = partsToComponents({ street: '1 Main St', locality: 'Springfield', region: 'IL', postcode: '62701', country: 'USA' });
    expect(us.map(c => `${c.kind}:${c.value}`)).toEqual([
      'number:1', 'separator: ', 'name:Main St', 'locality:Springfield', 'region:IL', 'separator: ', 'postcode:62701', 'country:USA',
    ]);
  });

  it('formats an address one line per part, for its country', () => {
    expect(formatAddressLines(german)).toEqual(['Hauptstraße 1', '10000 Berlin', 'Germany']);
    expect(formatAddressLines({ components: [
      { kind: 'number', value: '1' }, { kind: 'name', value: 'Main St' }, { kind: 'locality', value: 'Springfield' },
      { kind: 'region', value: 'IL' }, { kind: 'postcode', value: '62701' }, { kind: 'country', value: 'USA' },
    ] })).toEqual(['1 Main St', 'Springfield, IL 62701', 'USA']);
    expect(formatAddressLines({ street: '10 Downing Street', locality: 'London', postcode: 'SW1A 2AA', country: 'United Kingdom' }))
      .toEqual(['10 Downing Street', 'London', 'SW1A 2AA', 'United Kingdom']);
    expect(formatAddressLines({ full: 'Somewhere 1\n12345 Town' })).toEqual(['Somewhere 1', '12345 Town']);
  });
});
