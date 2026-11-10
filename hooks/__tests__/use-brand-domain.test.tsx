import { render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Email, Identity } from '@/lib/jmap/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { parseAuthenticationResults } from '@/lib/email-headers';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { Avatar } from '@/components/ui/avatar';
import { useBrandDomain } from '../use-brand-domain';

// Mail between two mailboxes of one Stalwart carries no Authentication-Results
// header, so its sender logo goes by the organisation's own domains instead.

const message = (from: string, header?: string) => ({
  from: [{ email: from }],
  ...(header ? { authenticationResults: parseAuthenticationResults([header]) } : {}),
}) as Pick<Email, 'from' | 'authenticationResults' | 'sourceClientAccountId'>;

function setListedDomains(domains: string[]) {
  usePolicyStore.setState({
    policy: {
      ...DEFAULT_POLICY,
      organisation: { ...DEFAULT_ORGANISATION_POLICY, externalMail: { ...DEFAULT_ORGANISATION_POLICY.externalMail, domains } },
    },
  });
}

const brandDomain = (email: Parameters<typeof useBrandDomain>[0]) => renderHook(() => useBrandDomain(email)).result.current;

beforeEach(() => {
  setListedDomains([]);
  useAuthStore.setState({ identities: [{ id: 'i1', name: 'Alice', email: 'alice@example.org' } as unknown as Identity] });
});

describe('useBrandDomain', () => {
  it('names the domain of a colleague on the same server', () => {
    expect(brandDomain(message('bob@example.org'))).toBe('example.org');
  });

  it('names a domain the admin listed as the organisation\'s own', () => {
    expect(brandDomain(message('dave@org-two.test'))).toBeUndefined();
    setListedDomains(['org-two.test']);
    expect(brandDomain(message('dave@org-two.test'))).toBe('org-two.test');
  });

  it('counts the identities\' domains before any policy has loaded', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, organisation: undefined } });
    expect(brandDomain(message('bob@example.org'))).toBe('example.org');
  });

  it('keeps asking for the DMARC pass on mail that came in from outside', () => {
    expect(brandDomain(message('bob@example.org', 'mx.example; spf=softfail smtp.mailfrom=evil.example; dmarc=none header.from=example.org'))).toBeUndefined();
    expect(brandDomain(message('news@brand.org', 'mx.example; dmarc=pass header.from=brand.org'))).toBe('brand.org');
    expect(brandDomain(message('news@brand.org'))).toBeUndefined();
  });

  it('gives nothing without a message', () => {
    expect(brandDomain(undefined)).toBeUndefined();
    expect(brandDomain(null)).toBeUndefined();
  });

  it('reaches the avatar as the logo request', () => {
    function Sender({ email }: { email: ReturnType<typeof message> }) {
      return <Avatar email={email.from?.[0]?.email ?? undefined} brandDomain={useBrandDomain(email)} />;
    }
    const { container } = render(<Sender email={message('bob@example.org')} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/bimi?domain=example.org');
  });
});
