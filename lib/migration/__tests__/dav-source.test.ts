// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DisallowedUrlError } from '@/lib/security/url-guard';
import { createDavSource, type DavFetch, type DavRequestInit } from '../dav-source';
import { parseMultistatus, parseXml, XmlError } from '../dav-xml';
import { SourceError } from '../types';

// Fixtures follow what Open-Xchange and SabreDAV (Nextcloud, Kopano) answer.

interface Call {
  url: string;
  init: DavRequestInit;
  options: { allowPrivateHost?: string };
}

type Route = (init: DavRequestInit) => Response;

const ms = (body: string) => () => new Response(body, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } });

function fakeFetch(routes: Record<string, Route | Error>) {
  const calls: Call[] = [];
  const fetch: DavFetch = async (url, init, options) => {
    calls.push({ url, init, options });
    const route = routes[`${init.method} ${url}`];
    if (!route) throw new Error(`Unexpected ${init.method} ${url}`);
    if (route instanceof Error) throw route;
    return route(init);
  };
  return { fetch, calls };
}

const source = (kind: 'carddav' | 'caldav', url: string, fetch: DavFetch, allowPrivateHost = false) =>
  createDavSource({ kind, url, username: 'anna', password: 's3cret-pw', allowPrivateHost, fetch });

const BASIC = `Basic ${Buffer.from('anna:s3cret-pw').toString('base64')}`;

async function sourceError(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SourceError);
    return err as SourceError;
  }
  throw new Error('expected a SourceError');
}

// ─── Open-Xchange ──────────────────────────────────────────────────────────

const OX = 'https://ox.example.com';

const oxPrincipalOnStart = (path: string) => `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${path}</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal><D:href>/principals/users/3/</D:href></D:current-user-principal>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><D:displayname/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

// Default namespace for DAV: and other prefixes: must read the same as D:.
const oxPrincipal = (homeXml: string) => `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/principals/users/3/</href>
    <propstat>
      <prop>${homeXml}</prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

const oxBooks = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/carddav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/carddav/32/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><CARD:addressbook/></D:resourcetype>
        <D:displayname>Collected addresses</D:displayname>
        <CS:getctag>"1700000000000"</CS:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/carddav/Contacts/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><CARD:addressbook/></D:resourcetype>
        <D:displayname>Contacts</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

const oxCalendars = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <response>
    <href>/caldav/</href>
    <propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>/caldav/Y2FsOi8vMC8zMQ/</href>
    <propstat>
      <prop>
        <resourcetype><collection/><C:calendar/></resourcetype>
        <displayname>Calendar</displayname>
        <A:calendar-color>#FF2968FF</A:calendar-color>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <response>
    <href>/caldav/Y2FsOi8vMC8zNQ/</href>
    <propstat>
      <prop>
        <resourcetype><collection/><C:calendar/></resourcetype>
        <displayname>Tasks</displayname>
        <C:supported-calendar-component-set><C:comp name="vtodo"/></C:supported-calendar-component-set>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
    <propstat><prop><A:calendar-color/></prop><status>HTTP/1.1 404 Not Found</status></propstat>
  </response>
  <response>
    <href>/caldav/schedule-inbox/</href>
    <propstat>
      <prop><resourcetype><collection/><C:schedule-inbox/></resourcetype><displayname>Inbox</displayname></prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

// ─── SabreDAV (Nextcloud, Kopano) ─────────────────────────────────────────

const SABRE = 'https://cloud.example.com';

const sabreStart = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:card="urn:ietf:params:xml:ns:carddav">
 <d:response>
  <d:href>/remote.php/dav/</d:href>
  <d:propstat><d:prop>
   <d:current-user-principal><d:href>/remote.php/dav/principals/users/alice/</d:href></d:current-user-principal>
   <d:resourcetype><d:collection/></d:resourcetype>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><card:addressbook-home-set/><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
</d:multistatus>`;

const sabrePrincipal = (homeXml: string) => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/principals/users/alice/</d:href>
  <d:propstat><d:prop>${homeXml}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>`;

const sabreBooks = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
 <d:response>
  <d:href>/remote.php/dav/addressbooks/users/alice/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/addressbooks/users/alice/z-app-generated--contactsinteraction--recent/</d:href>
  <d:propstat><d:prop>
   <d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>
   <d:displayname>Recently contacted</d:displayname>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/addressbooks/users/alice/contacts/</d:href>
  <d:propstat><d:prop>
   <d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
</d:multistatus>`;

const sabreCalendars = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:x1="http://apple.com/ns/ical/" xmlns:nc="http://nextcloud.com/ns">
 <d:response>
  <d:href>/remote.php/dav/calendars/users/alice/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/users/alice/personal/</d:href>
  <d:propstat><d:prop>
   <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
   <d:displayname>Personal</d:displayname>
   <x1:calendar-color>#0082c9</x1:calendar-color>
   <cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/users/alice/trashbin/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/><nc:trash-bin/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>`;

describe('createDavSource: discovery', () => {
  it('finds the Open-Xchange address books through the principal and marks Contacts as default', async () => {
    const { fetch, calls } = fakeFetch({
      [`PROPFIND ${OX}/carddav/`]: (init) => (init.headers.depth === '0' ? ms(oxPrincipalOnStart('/carddav/'))() : ms(oxBooks)()),
      [`PROPFIND ${OX}/principals/users/3/`]: ms(oxPrincipal('<card:addressbook-home-set><href>/carddav/</href></card:addressbook-home-set>')),
    });
    const collections = await source('carddav', `${OX}/carddav/`, fetch).listCollections();
    expect(collections).toEqual([
      { href: '/carddav/32/', name: 'Collected addresses', isDefault: false },
      { href: '/carddav/Contacts/', name: 'Contacts', isDefault: true },
    ]);
    expect(calls.map((c) => `${c.init.method} ${c.url} ${c.init.headers.depth}`)).toEqual([
      `PROPFIND ${OX}/carddav/ 0`,
      `PROPFIND ${OX}/principals/users/3/ 0`,
      `PROPFIND ${OX}/carddav/ 1`,
    ]);
    expect(calls[0].init.body).toContain('current-user-principal');
    expect(calls[1].init.body).toMatch(/<card:addressbook-home-set\/>/);
    expect(calls.every((c) => c.init.headers.authorization === BASIC)).toBe(true);
    expect(calls.every((c) => Object.keys(c.options).length === 0)).toBe(true);
  });

  it('reads Open-Xchange calendars with colours without alpha and their components', async () => {
    const { fetch } = fakeFetch({
      [`PROPFIND ${OX}/caldav/`]: (init) => (init.headers.depth === '0' ? ms(oxPrincipalOnStart('/caldav/'))() : ms(oxCalendars)()),
      [`PROPFIND ${OX}/principals/users/3/`]: ms(oxPrincipal('<cal:calendar-home-set><href>/caldav/</href></cal:calendar-home-set>')),
    });
    const collections = await source('caldav', `${OX}/caldav/`, fetch).listCollections();
    expect(collections).toEqual([
      { href: '/caldav/Y2FsOi8vMC8zMQ/', name: 'Calendar', color: '#ff2968', components: ['VEVENT'] },
      { href: '/caldav/Y2FsOi8vMC8zNQ/', name: 'Tasks', components: ['VTODO'] },
    ]);
  });

  it('finds SabreDAV address books, naming one without displayname by its path', async () => {
    const { fetch } = fakeFetch({
      [`PROPFIND ${SABRE}/remote.php/dav/`]: ms(sabreStart),
      [`PROPFIND ${SABRE}/remote.php/dav/principals/users/alice/`]: ms(
        sabrePrincipal('<card:addressbook-home-set><d:href>/remote.php/dav/addressbooks/users/alice/</d:href></card:addressbook-home-set>'),
      ),
      [`PROPFIND ${SABRE}/remote.php/dav/addressbooks/users/alice/`]: ms(sabreBooks),
    });
    const collections = await source('carddav', `${SABRE}/remote.php/dav/`, fetch).listCollections();
    expect(collections).toEqual([
      { href: '/remote.php/dav/addressbooks/users/alice/z-app-generated--contactsinteraction--recent/', name: 'Recently contacted', isDefault: false },
      { href: '/remote.php/dav/addressbooks/users/alice/contacts/', name: 'contacts', isDefault: true },
    ]);
  });

  it('finds SabreDAV calendars and leaves out the trash bin', async () => {
    const { fetch } = fakeFetch({
      [`PROPFIND ${SABRE}/remote.php/dav/`]: ms(sabreStart),
      [`PROPFIND ${SABRE}/remote.php/dav/principals/users/alice/`]: ms(
        sabrePrincipal('<cal:calendar-home-set><d:href>/remote.php/dav/calendars/users/alice/</d:href></cal:calendar-home-set>'),
      ),
      [`PROPFIND ${SABRE}/remote.php/dav/calendars/users/alice/`]: ms(sabreCalendars),
    });
    const collections = await source('caldav', `${SABRE}/remote.php/dav/`, fetch).listCollections();
    expect(collections).toEqual([
      { href: '/remote.php/dav/calendars/users/alice/personal/', name: 'Personal', color: '#0082c9', components: ['VEVENT', 'VTODO'] },
    ]);
  });

  it('makes the first book the default when none looks like one', async () => {
    const books = oxBooks.replace('/carddav/Contacts/', '/carddav/40/').replace('>Contacts<', '>Work<');
    const { fetch } = fakeFetch({
      [`PROPFIND ${OX}/carddav/`]: (init) => (init.headers.depth === '0' ? ms(oxPrincipalOnStart('/carddav/'))() : ms(books)()),
      [`PROPFIND ${OX}/principals/users/3/`]: ms(oxPrincipal('<card:addressbook-home-set><href>/carddav/</href></card:addressbook-home-set>')),
    });
    const collections = await source('carddav', `${OX}/carddav/`, fetch).listCollections();
    expect(collections.map((c) => [c.name, c.isDefault])).toEqual([['Collected addresses', true], ['Work', false]]);
  });

  it('treats the address as the home when there is no principal or home set', async () => {
    const bare = oxPrincipalOnStart('/carddav/').replace(/<D:current-user-principal>.*<\/D:current-user-principal>/, '');
    const { fetch, calls } = fakeFetch({
      [`PROPFIND ${OX}/carddav/`]: (init) => (init.headers.depth === '0' ? ms(bare)() : ms(oxBooks)()),
    });
    const collections = await source('carddav', `${OX}/carddav/`, fetch).listCollections();
    expect(collections.map((c) => c.href)).toEqual(['/carddav/32/', '/carddav/Contacts/']);
    expect(calls).toHaveLength(2);
  });

  it('returns just the calendar when the address is a calendar itself', async () => {
    const one = oxCalendars.replace(/<response>\s*<href>\/caldav\/<\/href>[\s\S]*?<\/response>/, '');
    const { fetch, calls } = fakeFetch({ [`PROPFIND ${OX}/caldav/Y2FsOi8vMC8zMQ/`]: ms(one) });
    const collections = await source('caldav', `${OX}/caldav/Y2FsOi8vMC8zMQ/`, fetch).listCollections();
    expect(collections).toEqual([{ href: '/caldav/Y2FsOi8vMC8zMQ/', name: 'Calendar', color: '#ff2968', components: ['VEVENT'] }]);
    expect(calls).toHaveLength(1);
  });
});

describe('createDavSource: objects', () => {
  const members = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/carddav/Contacts/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:getetag>"c-1"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/carddav/Contacts/sub/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/carddav/Contacts/1001.vcf</D:href>
    <D:propstat><D:prop><D:resourcetype/><D:getetag>"1700000000001"</D:getetag><D:getcontenttype>text/vcard; charset=utf-8</D:getcontenttype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/carddav/Contacts/a%40b.vcf</D:href>
    <D:propstat><D:prop><D:resourcetype/><D:getetag>W/"x&amp;y"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    <D:propstat><D:prop><D:getcontenttype/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/carddav/Contacts/stray.ics</D:href>
    <D:propstat><D:prop><D:resourcetype/><D:getetag>"9"</D:getetag><D:getcontenttype>text/calendar</D:getcontenttype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;

  it('lists members with their etags as sent, skipping the collection, sub-collections and other types', async () => {
    const { fetch, calls } = fakeFetch({ [`PROPFIND ${OX}/carddav/Contacts/`]: ms(members) });
    const refs = await source('carddav', `${OX}/carddav/`, fetch).listObjects('/carddav/Contacts/');
    expect(refs).toEqual([
      { href: '/carddav/Contacts/1001.vcf', etag: '"1700000000001"' },
      { href: '/carddav/Contacts/a%40b.vcf', etag: 'W/"x&y"' },
    ]);
    expect(calls[0].init.headers.depth).toBe('1');
    expect(calls[0].init.body).toContain('<d:getetag/>');
  });

  const cardMultiget = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <response>
    <href>/carddav/Contacts/1001.vcf</href>
    <propstat><prop><getetag>"e1"</getetag><C:address-data>BEGIN:VCARD&#13;
VERSION:3.0&#13;
FN:Smith &amp; Sons&#13;
NOTE:a &lt;b&gt; &#x263A;&#13;
END:VCARD&#13;
</C:address-data></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>/carddav/Contacts/a@b.vcf</href>
    <propstat><prop><getetag>"e2"</getetag><C:address-data><![CDATA[BEGIN:VCARD
FN:Tom & Jerry <cdata>
END:VCARD
]]></C:address-data></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>/carddav/Contacts/gone.vcf</href>
    <status>HTTP/1.1 404 Not Found</status>
  </response>
</multistatus>`;

  it('reads address-data from a multiget, entities and CDATA decoded, matching hrefs across encodings', async () => {
    const { fetch, calls } = fakeFetch({ [`REPORT ${OX}/carddav/Contacts/`]: ms(cardMultiget) });
    const objects = await source('carddav', `${OX}/carddav/`, fetch)
      .fetchObjects('/carddav/Contacts/', ['/carddav/Contacts/1001.vcf', '/carddav/Contacts/a%40b.vcf', '/carddav/Contacts/gone.vcf']);
    expect(objects).toEqual([
      { href: '/carddav/Contacts/1001.vcf', etag: '"e1"', data: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Smith & Sons\r\nNOTE:a <b> ☺\r\nEND:VCARD\r\n' },
      { href: '/carddav/Contacts/a%40b.vcf', etag: '"e2"', data: 'BEGIN:VCARD\nFN:Tom & Jerry <cdata>\nEND:VCARD\n' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.depth).toBe('1');
    expect(calls[0].init.body).toMatch(/^<\?xml[^>]*\?>\s*<card:addressbook-multiget /);
    expect(calls[0].init.body).toContain('<d:href>/carddav/Contacts/a%40b.vcf</d:href>');
    expect(calls[0].init.body).toContain('<card:address-data/>');
  });

  it('reads calendar-data from a calendar-multiget', async () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response>
<d:href>/remote.php/dav/calendars/users/alice/personal/ev1.ics</d:href>
<d:propstat><d:prop><d:getetag>"abc"</d:getetag><cal:calendar-data>BEGIN:VCALENDAR
SUMMARY:R&amp;D review
END:VCALENDAR</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response></d:multistatus>`;
    const { fetch, calls } = fakeFetch({ [`REPORT ${SABRE}/remote.php/dav/calendars/users/alice/personal/`]: ms(xml) });
    const objects = await source('caldav', `${SABRE}/remote.php/dav/`, fetch)
      .fetchObjects('/remote.php/dav/calendars/users/alice/personal/', ['/remote.php/dav/calendars/users/alice/personal/ev1.ics']);
    expect(objects).toEqual([{ href: '/remote.php/dav/calendars/users/alice/personal/ev1.ics', etag: '"abc"', data: 'BEGIN:VCALENDAR\nSUMMARY:R&D review\nEND:VCALENDAR' }]);
    expect(calls[0].init.body).toContain('<cal:calendar-multiget ');
  });

  it('falls back to GET per object when the multiget is refused, leaving out a 404', async () => {
    const { fetch, calls } = fakeFetch({
      [`REPORT ${OX}/carddav/Contacts/`]: () => new Response('Not Implemented', { status: 501 }),
      [`GET ${OX}/carddav/Contacts/1.vcf`]: () => new Response('BEGIN:VCARD\r\nEND:VCARD\r\n', { status: 200, headers: { etag: '"g1"' } }),
      [`GET ${OX}/carddav/Contacts/2.vcf`]: () => new Response('nope', { status: 404 }),
    });
    const objects = await source('carddav', `${OX}/carddav/`, fetch)
      .fetchObjects('/carddav/Contacts/', ['/carddav/Contacts/1.vcf', '/carddav/Contacts/2.vcf']);
    expect(objects).toEqual([{ href: '/carddav/Contacts/1.vcf', etag: '"g1"', data: 'BEGIN:VCARD\r\nEND:VCARD\r\n' }]);
    expect(calls.map((c) => c.init.method)).toEqual(['REPORT', 'GET', 'GET']);
    expect(calls[1].init.headers.authorization).toBe(BASIC);
  });

  it('sends multigets in chunks of 50', async () => {
    const hrefs = Array.from({ length: 120 }, (_, i) => `/carddav/Contacts/${i}.vcf`);
    const { fetch, calls } = fakeFetch({
      [`REPORT ${OX}/carddav/Contacts/`]: (init) => {
        const sent = [...(init.body ?? '').matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1]);
        const body = sent.map((h) => `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:getetag>"1"</D:getetag><C:address-data>BEGIN:VCARD</C:address-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('');
        return ms(`<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${body}</D:multistatus>`)();
      },
    });
    const objects = await source('carddav', `${OX}/carddav/`, fetch).fetchObjects('/carddav/Contacts/', hrefs);
    expect(objects.map((o) => o.href)).toEqual(hrefs);
    expect(calls).toHaveLength(3);
  });

  it('does not expand a DOCTYPE entity in a multiget and fetches the objects one by one instead', async () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE d [<!ENTITY xxe "EXPANDED-SECRET">]>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:response><D:href>/carddav/Contacts/1.vcf</D:href>
<D:propstat><D:prop><D:getetag>"1"</D:getetag><C:address-data>FN:&xxe;</C:address-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response></D:multistatus>`;
    const { fetch, calls } = fakeFetch({
      [`REPORT ${OX}/carddav/Contacts/`]: ms(xxe),
      [`GET ${OX}/carddav/Contacts/1.vcf`]: () => new Response('FN:plain', { status: 200, headers: { etag: '"1"' } }),
    });
    const objects = await source('carddav', `${OX}/carddav/`, fetch).fetchObjects('/carddav/Contacts/', ['/carddav/Contacts/1.vcf']);
    expect(objects).toEqual([{ href: '/carddav/Contacts/1.vcf', etag: '"1"', data: 'FN:plain' }]);
    expect(JSON.stringify(objects)).not.toContain('EXPANDED-SECRET');
    expect(calls.map((c) => c.init.method)).toEqual(['REPORT', 'GET']);
  });

  it('rejects a DOCTYPE in a PROPFIND answer as a protocol error', async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><D:multistatus xmlns:D="DAV:"/>`;
    const { fetch } = fakeFetch({ [`PROPFIND ${OX}/carddav/`]: ms(xxe) });
    const err = await sourceError(source('carddav', `${OX}/carddav/`, fetch).listCollections());
    expect(err.kind).toBe('protocol');
  });
});

describe('createDavSource: redirects', () => {
  const start = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
  const redirect = (status: number, location: string) => () => new Response(null, { status, headers: { location } });

  it('keeps method, body and Authorization on the same origin', async () => {
    const { fetch, calls } = fakeFetch({
      [`PROPFIND https://dav.example.com/.well-known/carddav`]: redirect(301, '/dav/'),
      [`PROPFIND https://dav.example.com/dav/`]: ms(start),
    });
    await source('carddav', 'https://dav.example.com/.well-known/carddav', fetch).listCollections();
    expect(calls[1].url).toBe('https://dav.example.com/dav/');
    expect(calls[1].init.method).toBe('PROPFIND');
    expect(calls[1].init.body).toBe(calls[0].init.body);
    expect(calls[1].init.headers.authorization).toBe(BASIC);
  });

  it('drops Authorization when the redirect leaves for another host', async () => {
    const { fetch, calls } = fakeFetch({
      [`PROPFIND https://dav.example.com/dav/`]: redirect(307, 'https://other.example.net/dav/'),
      [`PROPFIND https://other.example.net/dav/`]: ms(start),
    });
    await source('carddav', 'https://dav.example.com/dav/', fetch).listCollections();
    expect(calls[0].init.headers.authorization).toBe(BASIC);
    expect(calls[1].url).toBe('https://other.example.net/dav/');
    expect(calls[1].init.headers.authorization).toBeUndefined();
  });

  it('keeps Authorization for an https upgrade and passes the private host only for the configured name', async () => {
    const { fetch, calls } = fakeFetch({
      [`PROPFIND http://dav.example.com/dav/`]: redirect(308, 'https://dav.example.com/dav/'),
      [`PROPFIND https://dav.example.com/dav/`]: ms(start),
    });
    await source('carddav', 'http://dav.example.com/dav/', fetch, true).listCollections();
    expect(calls.map((c) => c.url)).toEqual(['http://dav.example.com/dav/', 'https://dav.example.com/dav/', 'https://dav.example.com/dav/']);
    expect(calls.every((c) => c.init.headers.authorization === BASIC)).toBe(true);
    expect(calls.every((c) => c.options.allowPrivateHost === 'dav.example.com')).toBe(true);
  });

  it('gives up after five redirects', async () => {
    const { fetch, calls } = fakeFetch({ [`PROPFIND https://dav.example.com/dav/`]: redirect(302, '/dav/') });
    const err = await sourceError(source('carddav', 'https://dav.example.com/dav/', fetch).listCollections());
    expect(err.kind).toBe('protocol');
    expect(calls).toHaveLength(6);
  });
});

describe('createDavSource: errors', () => {
  it('maps 401 to auth without the password in the message', async () => {
    const { fetch } = fakeFetch({ [`PROPFIND ${OX}/carddav/`]: () => new Response('no', { status: 401 }) });
    const err = await sourceError(source('carddav', `${OX}/carddav/`, fetch).listCollections());
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('s3cret-pw');
  });

  it('maps DisallowedUrlError to blocked', async () => {
    const { fetch } = fakeFetch({ [`PROPFIND ${OX}/carddav/`]: new DisallowedUrlError(`${OX}/carddav/`) });
    expect((await sourceError(source('carddav', `${OX}/carddav/`, fetch).listCollections())).kind).toBe('blocked');
  });

  it('refuses http without allowPrivateHost before any request', async () => {
    const { fetch, calls } = fakeFetch({});
    expect((await sourceError(source('carddav', 'http://dav.example.com/dav/', fetch).listCollections())).kind).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('refuses a redirect down to http without allowPrivateHost', async () => {
    const { fetch, calls } = fakeFetch({
      [`PROPFIND https://dav.example.com/dav/`]: () => new Response(null, { status: 301, headers: { location: 'http://dav.example.com/dav/' } }),
    });
    expect((await sourceError(source('carddav', 'https://dav.example.com/dav/', fetch).listCollections())).kind).toBe('blocked');
    expect(calls).toHaveLength(1);
  });

  it('maps certificate errors to tls and DNS failures to network', async () => {
    const tls = new TypeError('fetch failed', { cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
    const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    const a = fakeFetch({ [`PROPFIND ${OX}/carddav/`]: tls });
    const b = fakeFetch({ [`PROPFIND ${OX}/carddav/`]: dns });
    expect((await sourceError(source('carddav', `${OX}/carddav/`, a.fetch).listCollections())).kind).toBe('tls');
    const network = await sourceError(source('carddav', `${OX}/carddav/`, b.fetch).listCollections());
    expect(network.kind).toBe('network');
    expect(network.message).toContain('ENOTFOUND');
  });

  it('maps a timeout to network', async () => {
    const fetch: DavFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    const dav = createDavSource({ kind: 'carddav', url: `${OX}/carddav/`, username: 'u', password: 'p', allowPrivateHost: false, fetch, timeoutMs: 20 });
    const err = await sourceError(dav.listCollections());
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/in time/);
  });

  it('maps a non-multistatus answer to protocol', async () => {
    const { fetch } = fakeFetch({ [`PROPFIND ${OX}/carddav/`]: () => new Response('<html/>', { status: 200 }) });
    expect((await sourceError(source('carddav', `${OX}/carddav/`, fetch).listCollections())).kind).toBe('protocol');
  });
});

describe('dav-xml', () => {
  it('refuses DOCTYPEs and unknown entities instead of expanding them', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(XmlError);
    expect(() => parseXml('<a>&x;</a>')).toThrow(/Unknown entity/);
    expect(() => parseXml('<a>Tom & Jerry</a>')).toThrow(XmlError);
  });

  it('refuses mismatched tags, undeclared prefixes and deep nesting', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow(/Mismatched/);
    expect(() => parseXml('<x:a/>')).toThrow(/Undeclared/);
    expect(() => parseXml(`${'<a>'.repeat(100)}${'</a>'.repeat(100)}`)).toThrow(/deeply/);
  });

  it('resolves prefixes per scope and skips comments and processing instructions', () => {
    const responses = parseMultistatus(`<?xml version="1.0"?><!-- hi --><x:multistatus xmlns:x="DAV:">
      <response xmlns="DAV:"><href> /a/ </href><?pi stuff?><propstat><prop><y:displayname xmlns:y="DAV:">A&#38;B</y:displayname></prop>
      <status>HTTP/1.1 200 OK</status></propstat></response>
      <x:response xmlns="urn:other"><x:href>/b/</x:href><href>ignored</href></x:response>
    </x:multistatus>`);
    expect(responses).toEqual([
      { href: '/a/', propstats: [{ status: 200, props: [{ ns: 'DAV:', local: 'displayname', attrs: { 'xmlns:y': 'DAV:' }, children: [], text: 'A&B' }] }] },
      { href: '/b/', propstats: [] },
    ]);
  });
});
