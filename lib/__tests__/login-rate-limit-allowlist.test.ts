import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as VerifyBudget from '@/lib/auth/verify-budget';

/**
 * Everyone behind one NAT address shares the sign-in failure budget, so the
 * networks an admin puts on LOGIN_RATE_LIMIT_ALLOWLIST skip it. The list
 * decides who may try passwords without a cap, so it must match exactly the
 * networks it names and ignore anything it cannot use.
 */

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { warn: (...args: unknown[]) => warn(...args), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

let budget: typeof VerifyBudget;

beforeEach(async () => {
  warn.mockClear();
  vi.resetModules();
  budget = await import('@/lib/auth/verify-budget');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const allow = (list: string) => vi.stubEnv('LOGIN_RATE_LIMIT_ALLOWLIST', list);
const exempt = (client: string) => budget.isExemptFromLoginBudget(client);

describe('LOGIN_RATE_LIMIT_ALLOWLIST', () => {
  it('exempts nobody when unset or empty', () => {
    expect(process.env.LOGIN_RATE_LIMIT_ALLOWLIST).toBeUndefined();
    expect(exempt('203.0.113.10')).toBe(false);
    allow(' , ');
    expect(exempt('203.0.113.10')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('matches a single address exactly', () => {
    allow('203.0.113.10');
    expect(exempt('203.0.113.10')).toBe(true);
    expect(exempt('203.0.113.11')).toBe(false);
    expect(exempt('203.0.113.1')).toBe(false);
  });

  it('matches an IPv4 range up to its boundaries', () => {
    allow('198.51.100.0/24');
    expect(exempt('198.51.100.0')).toBe(true);
    expect(exempt('198.51.100.255')).toBe(true);
    expect(exempt('198.51.99.255')).toBe(false);
    expect(exempt('198.51.101.0')).toBe(false);
  });

  it('reads a range written with host bits as its network', () => {
    allow('198.51.100.77/30');
    expect(exempt('198.51.100.76')).toBe(true);
    expect(exempt('198.51.100.79')).toBe(true);
    expect(exempt('198.51.100.75')).toBe(false);
    expect(exempt('198.51.100.80')).toBe(false);
  });

  it('matches an IPv6 range in any spelling', () => {
    allow('2001:db8:1::/48');
    expect(exempt('2001:db8:1::7')).toBe(true);
    expect(exempt('2001:0DB8:0001:FFFF::1')).toBe(true);
    expect(exempt('2001:db8:2::7')).toBe(false);
  });

  it('treats an IPv4-mapped client as its IPv4 address', () => {
    allow('198.51.100.0/24');
    expect(exempt('::ffff:198.51.100.9')).toBe(true);
    expect(exempt('::ffff:c633:6409')).toBe(true);
    expect(exempt('0000:0000:0000:0000:0000:ffff:198.51.100.9')).toBe(true);
    expect(exempt('::ffff:198.51.101.9')).toBe(false);
  });

  it('matches each family only against entries of its own family', () => {
    allow('::/0');
    expect(exempt('2001:db8::1')).toBe(true);
    expect(exempt('198.51.100.9')).toBe(false);
    expect(exempt('::ffff:198.51.100.9')).toBe(false);
    expect(exempt('0.0.0.0')).toBe(false);
    allow('0.0.0.0/0');
    expect(exempt('198.51.100.9')).toBe(true);
    expect(exempt('::ffff:198.51.100.9')).toBe(true);
    expect(exempt('2001:db8::1')).toBe(false);
  });

  it('takes commas, spaces and newlines as separators', () => {
    allow('203.0.113.10,198.51.100.0/24\n2001:db8::/32   192.0.2.7');
    for (const client of ['203.0.113.10', '198.51.100.20', '2001:db8::5', '192.0.2.7']) {
      expect(exempt(client)).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores and logs entries it cannot use, and keeps the rest', () => {
    allow([
      'office.example.com',
      '198.51.100.0/33',
      '2001:db8::/129',
      '203.0.113.0/-1',
      '203.0.113.0/x',
      '203.0.113.0/',
      '198.51.100.0/024',
      '0.0.0.0/00',
      '192.0.002.1',
      '[2001:db8::]/32',
      'fe80::1%eth0',
      '::ffff:198.51.100.0/120',
      '203.0.113.10',
    ].join(','));
    expect(exempt('203.0.113.10')).toBe(true);
    for (const client of ['198.51.100.1', '::ffff:198.51.100.1', '2001:db8::1', '203.0.113.11', '192.0.2.1', 'fe80::1', '0.0.0.0']) {
      expect(exempt(client)).toBe(false);
    }
    // Once per entry, not once per sign-in.
    expect(warn).toHaveBeenCalledTimes(12);
  });

  it('never exempts a client key that is not an address', () => {
    allow('0.0.0.0/0, ::/0');
    expect(exempt('203.0.113.10')).toBe(true);
    expect(exempt('2001:db8::1')).toBe(true);
    for (const client of ['', 'unknown', '203.0.113.10, 198.51.100.1', '203.0.113.010', '[2001:db8::1]', '203.0.113.10:443', 'evil\u0000']) {
      expect(exempt(client)).toBe(false);
    }
  });

  it('refuses a client key with a zone id', () => {
    allow('192.0.2.1, fe80::/10');
    // Node cuts the address in front of a zone id to 39 characters, which
    // would turn this one into ::ffff:192.0.2.1.
    expect(exempt('0000:0000:0000:0000:0000:ffff:192.0.2.10%x')).toBe(false);
    expect(exempt('fe80::1%eth0')).toBe(false);
    expect(exempt('0000:0000:0000:0000:0000:ffff:192.0.2.10')).toBe(false);
    expect(exempt('0000:0000:0000:0000:0000:ffff:192.0.2.1')).toBe(true);
    expect(exempt('fe80::1')).toBe(true);
  });

  it('follows a change of the variable', () => {
    allow('203.0.113.0/24');
    expect(exempt('203.0.113.10')).toBe(true);
    allow('198.51.100.0/24');
    expect(exempt('203.0.113.10')).toBe(false);
    expect(exempt('198.51.100.10')).toBe(true);
  });
});

describe('reserveLoginAttempt with LOGIN_RATE_LIMIT_ALLOWLIST', () => {
  it('spends no budget for an allowlisted client and still caps everyone else', () => {
    allow('203.0.113.0/24');
    for (let i = 0; i < 50; i++) {
      expect(budget.reserveLoginAttempt('203.0.113.10')).not.toBeNull();
    }
    for (let i = 0; i < 5; i++) {
      expect(budget.reserveLoginAttempt('198.51.100.7')).not.toBeNull();
    }
    expect(budget.reserveLoginAttempt('198.51.100.7')).toBeNull();
  });

  it('caps a client again as soon as its network leaves the list', () => {
    allow('203.0.113.0/24');
    for (let i = 0; i < 10; i++) budget.reserveLoginAttempt('203.0.113.10');
    allow('');
    for (let i = 0; i < 5; i++) {
      expect(budget.reserveLoginAttempt('203.0.113.10')).not.toBeNull();
    }
    expect(budget.reserveLoginAttempt('203.0.113.10')).toBeNull();
  });
});
