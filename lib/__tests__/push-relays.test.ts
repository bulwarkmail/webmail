// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELAY_BASE_URL,
  resolveActiveRelayUrl,
  resolveDefaultRelayUrl,
  resolvePushRelayOptions,
} from '@/lib/push-relays';

describe('resolvePushRelayOptions', () => {
  it('always offers the built-in relay first', () => {
    const options = resolvePushRelayOptions({});
    expect(options).toEqual([
      { label: 'notifications.relay.bulwarkmail.org', url: DEFAULT_RELAY_BASE_URL },
    ]);
  });

  it('appends admin relays and labels unlabelled ones by host', () => {
    const options = resolvePushRelayOptions({
      pushRelays: [
        { label: 'Company', url: 'https://push.company.example/' },
        { label: '  ', url: 'https://push.other.example' },
      ],
    });

    expect(options.slice(1)).toEqual([
      { label: 'Company', url: 'https://push.company.example' },
      { label: 'push.other.example', url: 'https://push.other.example' },
    ]);
  });

  it('drops invalid and duplicate relays', () => {
    const options = resolvePushRelayOptions({
      pushRelays: [
        { label: 'Empty', url: '' },
        { label: 'Not a URL', url: 'push.company.example' },
        { label: 'Dupe', url: DEFAULT_RELAY_BASE_URL },
      ],
    });

    expect(options).toHaveLength(1);
  });

  it('keeps a legacy single-URL policy selectable', () => {
    const options = resolvePushRelayOptions({ pushRelayUrl: 'https://legacy.example' });
    expect(options.map((o) => o.url)).toEqual([DEFAULT_RELAY_BASE_URL, 'https://legacy.example']);
  });
});

describe('resolveActiveRelayUrl', () => {
  const policy = {
    pushRelays: [{ label: 'Company', url: 'https://push.company.example' }],
    pushRelayUrl: 'https://push.company.example',
  };

  it('uses the admin default when the user has not chosen', () => {
    expect(resolveActiveRelayUrl(policy, '')).toBe('https://push.company.example');
    expect(resolveDefaultRelayUrl({})).toBe(DEFAULT_RELAY_BASE_URL);
  });

  it('honors a user choice that the policy still offers', () => {
    expect(resolveActiveRelayUrl(policy, DEFAULT_RELAY_BASE_URL)).toBe(DEFAULT_RELAY_BASE_URL);
  });

  it('ignores a user choice the policy does not offer', () => {
    expect(resolveActiveRelayUrl(policy, 'https://attacker.example')).toBe(
      'https://push.company.example',
    );
  });

  it('pins users to the default when the admin locked the choice', () => {
    expect(
      resolveActiveRelayUrl({ ...policy, pushRelayUrlLocked: true }, DEFAULT_RELAY_BASE_URL),
    ).toBe('https://push.company.example');
  });
});
