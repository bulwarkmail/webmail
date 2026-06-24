import { describe, it, expect } from 'vitest';
import { buildQuoteHeader } from '@/lib/quote-header';

const base = {
  newTo: [] as string[],
  newCc: [] as string[],
  locale: 'en',
  timeFormat: '24h' as const,
  unknownLabel: 'Unknown',
};

const sender = { name: 'Display Name', email: 'user@domain.tld' };

describe('buildQuoteHeader (#482 — sender address survives HTML rendering)', () => {
  it('forward TEXT keeps the full "Name <email>" sender', async () => {
    const h = await buildQuoteHeader({
      mode: 'forward',
      email: { from: [sender], subject: 'Hello', receivedAt: '2026-01-01T10:00:00Z' },
      ...base,
    });
    expect(h.text).toContain('From: Display Name <user@domain.tld>');
  });

  it('forward HTML escapes the angle brackets so the address is not eaten as a tag', async () => {
    const h = await buildQuoteHeader({
      mode: 'forward',
      email: { from: [sender], subject: 'Hello', receivedAt: '2026-01-01T10:00:00Z' },
      ...base,
    });
    // The regression: a raw "<user@domain.tld>" is parsed as an HTML tag by the
    // rich-text composer and dropped, leaving only "From: Display Name".
    expect(h.html).toContain('Display Name &lt;user@domain.tld&gt;');
    expect(h.html).not.toContain('<user@domain.tld>');
  });

  it('forward HTML escapes a subject containing markup (injection hardening)', async () => {
    const h = await buildQuoteHeader({
      mode: 'forward',
      email: { from: [sender], subject: 'Hi <b>x</b>', receivedAt: '2026-01-01T10:00:00Z' },
      ...base,
    });
    expect(h.html).toContain('Hi &lt;b&gt;x&lt;/b&gt;');
    expect(h.html).not.toContain('<b>x</b>');
  });

  it('forward HTML escapes a malicious display name', async () => {
    const h = await buildQuoteHeader({
      mode: 'forward',
      email: {
        from: [{ name: '<img src=x onerror=alert(1)>', email: 'evil@x.tld' }],
        subject: 'Hello',
        receivedAt: '2026-01-01T10:00:00Z',
      },
      ...base,
    });
    expect(h.html).not.toContain('<img src=x');
    expect(h.html).toContain('&lt;img src=x');
  });

  it('reply line includes the full "Name <email>" sender, escaped in HTML', async () => {
    const h = await buildQuoteHeader({
      mode: 'reply',
      email: { from: [sender], subject: 'Hello', receivedAt: '2026-01-01T10:00:00Z' },
      ...base,
    });
    // TEXT keeps the real angle brackets ("On <date>, Display Name <user@domain.tld> wrote:").
    expect(h.text).toContain('Display Name <user@domain.tld> wrote:');
    // HTML escapes them so the address survives the rich-text editor (#482).
    expect(h.html).toContain('Display Name &lt;user@domain.tld&gt;');
    expect(h.html).not.toContain('<user@domain.tld>');
  });

  it('reply line stays HTML-safe for a display name containing markup', async () => {
    const evil = await buildQuoteHeader({
      mode: 'reply',
      email: { from: [{ name: '<b>x</b>', email: 'e@x.tld' }], subject: 'Hello', receivedAt: '2026-01-01T10:00:00Z' },
      ...base,
    });
    expect(evil.html).not.toContain('<b>x</b>');
    expect(evil.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('reply line falls back to bare email when there is no display name', async () => {
    const h = await buildQuoteHeader({
      mode: 'reply',
      email: { from: [{ email: 'noname@x.tld' }], subject: 'Hello', receivedAt: '2026-01-01T10:00:00Z' },
      ...base,
    });
    expect(h.text).toContain('noname@x.tld wrote:');
    expect(h.text).not.toContain('<noname@x.tld>');
  });
});
