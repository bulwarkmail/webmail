import { describe, expect, it } from 'vitest';
import { localePrefixMode } from '../routing';

// #1626: the Docker image passes NEXT_PUBLIC_LOCALE_PREFIX="" when no build
// arg is given. next-intl reads an empty mode as "always", so / redirected
// to /en and the offline shell kept no page.
describe('localePrefixMode', () => {
  it('reads unset and empty as the documented default, never', () => {
    expect(localePrefixMode(undefined)).toBe('never');
    expect(localePrefixMode('')).toBe('never');
    expect(localePrefixMode('  ')).toBe('never');
  });

  it('keeps the three modes', () => {
    expect(localePrefixMode('always')).toBe('always');
    expect(localePrefixMode('as-needed')).toBe('as-needed');
    expect(localePrefixMode(' never ')).toBe('never');
  });

  it('does not pass anything else on to next-intl', () => {
    expect(localePrefixMode('sometimes')).toBe('never');
  });
});
