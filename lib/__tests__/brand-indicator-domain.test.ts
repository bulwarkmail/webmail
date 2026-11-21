import { describe, expect, it } from 'vitest';
import { brandIndicatorDomain, parseAuthenticationResults } from '@/lib/email-headers';

const message = (from: string, ...headers: string[]) => ({
  from: [{ email: from }],
  authenticationResults: headers.length ? parseAuthenticationResults(headers) : undefined,
  // As the full fetch reads headers the server wrote on receipt.
  authenticationResultsOnReceipt: headers.length ? true : undefined,
});

describe('brandIndicatorDomain', () => {
  it('names the From domain of a message that passed DMARC for it', () => {
    const email = message('news@Brand.org', 'mx.example; dkim=pass header.d=brand.org; spf=pass smtp.mailfrom=bounce.brand.org; dmarc=pass header.from=brand.org');
    expect(brandIndicatorDomain(email)).toBe('brand.org');
  });

  it('needs a DMARC verdict, not only an aligned DKIM pass', () => {
    expect(brandIndicatorDomain(message('news@brand.org', 'mx.example; dkim=pass header.d=brand.org; spf=pass smtp.mailfrom=brand.org'))).toBeUndefined();
    expect(brandIndicatorDomain(message('news@brand.org', 'mx.example; dkim=pass header.d=brand.org; dmarc=none header.from=brand.org'))).toBeUndefined();
  });

  it('refuses a pass the server recorded for another header.from', () => {
    expect(brandIndicatorDomain(message('ceo@bank.com', 'mx.example; dkim=pass header.d=lookalike.com; dmarc=pass header.from=lookalike.com'))).toBeUndefined();
  });

  it('trusts only the receiving server\'s own header, the topmost', () => {
    const forged = message(
      'ceo@bank.com',
      'mx.example; spf=fail smtp.mailfrom=bank.com; dmarc=fail header.from=bank.com',
      'mx.example; dkim=pass header.d=bank.com; dmarc=pass header.from=bank.com',
    );
    expect(brandIndicatorDomain(forged)).toBeUndefined();
  });

  it('gives nothing without results or a From', () => {
    expect(brandIndicatorDomain(message('news@brand.org'))).toBeUndefined();
    expect(brandIndicatorDomain({ from: [], authenticationResults: parseAuthenticationResults('mx.example; dmarc=pass header.from=brand.org') })).toBeUndefined();
    expect(brandIndicatorDomain(undefined)).toBeUndefined();
  });

  // Stalwart writes no Authentication-Results on mail a signed-in user hands in.
  describe('mail handed in on the same server', () => {
    const internal = ['brand.org', 'xn--bcher-kva.de'];

    it('names an internal From domain when there is no Authentication-Results header', () => {
      expect(brandIndicatorDomain(message('colleague@Brand.org'), internal)).toBe('brand.org');
    });

    it('covers a subdomain of an internal domain, not a lookalike', () => {
      expect(brandIndicatorDomain(message('news@eu.brand.org'), internal)).toBe('eu.brand.org');
      expect(brandIndicatorDomain(message('news@notbrand.org'), internal)).toBeUndefined();
      expect(brandIndicatorDomain(message('news@brand.org.evil.example'), internal)).toBeUndefined();
    });

    it('matches an IDN domain the message writes in Unicode', () => {
      expect(brandIndicatorDomain(message('info@bücher.de'), internal)).toBe('bücher.de');
    });

    it('leaves other domains without a header alone', () => {
      expect(brandIndicatorDomain(message('news@other.example'), internal)).toBeUndefined();
    });

    it('still needs the DMARC pass once the server wrote a header', () => {
      expect(brandIndicatorDomain(message('ceo@brand.org', 'mx.example; spf=none smtp.mailfrom=evil.example; dmarc=none header.from=brand.org'), internal)).toBeUndefined();
      expect(brandIndicatorDomain(message('ceo@brand.org', 'mx.example; dmarc=fail header.from=brand.org'), internal)).toBeUndefined();
      // A header with nothing readable in it is still a header.
      expect(brandIndicatorDomain(message('ceo@brand.org', 'mx.example; none'), internal)).toBeUndefined();
      expect(brandIndicatorDomain(message('ceo@brand.org', 'mx.example; dmarc=pass header.from=brand.org'), internal)).toBe('brand.org');
    });
  });
});
