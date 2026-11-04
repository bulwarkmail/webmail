import { describe, expect, it, vi } from 'vitest';
import { fetchMailClientConfig, mailClientConfigUrl, parseMailClientConfig } from '../mail-client-config';

// The autoconfig document Stalwart 1.0 serves (VM 106, 2026-11-04), cut down.
const STALWART = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
	<emailProvider id="example.org">
		<domain>example.org</domain>
		<incomingServer type="imap">
			<hostname>mail.example.org</hostname>
			<port>993</port>
			<socketType>SSL</socketType>
			<username>me@example.org</username>
			<authentication>password-cleartext</authentication>
		</incomingServer>
		<incomingServer type="pop3">
			<hostname>mail.example.org</hostname>
			<port>995</port>
			<socketType>SSL</socketType>
		</incomingServer>
		<outgoingServer type="smtp">
			<hostname>mail.example.org</hostname>
			<port>465</port>
			<socketType>SSL</socketType>
			<username>me@example.org</username>
		</outgoingServer>
	</emailProvider>
	<calendar type="caldav">
		<username>me@example.org</username>
		<serverURL>https://mail.example.org/dav/cal</serverURL>
	</calendar>
	<addressBook type="carddav">
		<serverURL>https://mail.example.org/dav/card</serverURL>
	</addressBook>
</clientConfig>`;

describe('parseMailClientConfig', () => {
  it('reads IMAP, SMTP, CalDAV and CardDAV from a Stalwart document', () => {
    expect(parseMailClientConfig(STALWART)).toEqual({
      username: 'me@example.org',
      imap: { hostname: 'mail.example.org', port: 993, security: 'ssl' },
      smtp: { hostname: 'mail.example.org', port: 465, security: 'ssl' },
      caldav: 'https://mail.example.org/dav/cal',
      carddav: 'https://mail.example.org/dav/card',
    });
  });

  it('tells STARTTLS and no encryption apart', () => {
    const xml = STALWART.replace('<port>465</port>\n\t\t\t<socketType>SSL', '<port>587</port>\n\t\t\t<socketType>STARTTLS')
      .replace('<port>993</port>\n\t\t\t<socketType>SSL', '<port>143</port>\n\t\t\t<socketType>plain');
    const config = parseMailClientConfig(xml);
    expect(config?.smtp).toEqual({ hostname: 'mail.example.org', port: 587, security: 'starttls' });
    expect(config?.imap).toEqual({ hostname: 'mail.example.org', port: 143, security: 'none' });
  });

  it('returns null for anything that is not a client config with a server', () => {
    expect(parseMailClientConfig('<html><body>Not found</body></html>')).toBeNull();
    expect(parseMailClientConfig('not xml at all <')).toBeNull();
    expect(parseMailClientConfig('<clientConfig version="1.1"><emailProvider/></clientConfig>')).toBeNull();
  });

  it('drops a DAV address that is not http(s)', () => {
    const config = parseMailClientConfig(STALWART.replace('https://mail.example.org/dav/cal', 'javascript:alert(1)'));
    expect(config?.caldav).toBeUndefined();
  });
});

describe('fetchMailClientConfig', () => {
  it('asks the signed-in server only, for the account address', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(STALWART, { status: 200 }));
    const config = await fetchMailClientConfig('https://mail.example.org/', 'me@example.org', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(mailClientConfigUrl('https://mail.example.org', 'me@example.org'));
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://mail.example.org/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=me%40example.org',
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
    expect(config?.imap?.port).toBe(993);
  });

  it('gives null on an error answer, a network failure or a name without @', async () => {
    expect(await fetchMailClientConfig('https://x.example', 'me@x.example', vi.fn().mockResolvedValue(new Response('', { status: 404 })))).toBeNull();
    expect(await fetchMailClientConfig('https://x.example', 'me@x.example', vi.fn().mockRejectedValue(new TypeError('offline')))).toBeNull();
    const never = vi.fn();
    expect(await fetchMailClientConfig('https://x.example', 'me', never)).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});
