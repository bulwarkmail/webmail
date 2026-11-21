import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('@/lib/auth/active-account-slot', () => ({
  getActiveAccountSlotHeaders: () => ({ 'X-JMAP-Cookie-Slot': '2' }),
}));

const lite = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/lite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lite')>();
  return { ...actual, get IS_LITE() { return lite.on; } };
});

import {
  buildMkCalendarBody,
  escapeXml,
  mkCalendarCollection,
  newCalendarCollectionName,
  parseCalendarCollectionComponents,
  fetchCalendarCollectionComponents,
  davComponentsFor,
} from '@/lib/webdav/calendar-collection';

let fetchSpy: Mock;

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildMkCalendarBody (#760)', () => {
  it('lists every requested component in the CalDAV namespace', () => {
    const body = buildMkCalendarBody('Work', ['VEVENT', 'VTODO']);
    expect(body).toContain('<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">');
    expect(body).toContain('<D:displayname>Work</D:displayname>');
    expect(body).toContain(
      '<C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>',
    );
  });

  it('escapes the display name', () => {
    expect(buildMkCalendarBody('R&D <2026> "beta"', ['VEVENT'])).toContain(
      '<D:displayname>R&amp;D &lt;2026&gt; &quot;beta&quot;</D:displayname>',
    );
    expect(escapeXml('a&b')).toBe('a&amp;b');
  });
});

describe('newCalendarCollectionName', () => {
  it('yields a short path-safe segment', () => {
    const name = newCalendarCollectionName();
    expect(name).toMatch(/^[0-9a-f]{16}$/);
    expect(newCalendarCollectionName()).not.toBe(name);
  });
});

describe('mkCalendarCollection', () => {
  it('posts MKCALENDAR through the proxy with the cal collection and account slot', async () => {
    const ok = await mkCalendarCollection({ collectionName: 'abc', displayName: 'Work', components: ['VEVENT'] });
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/webdav$/);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'X-WebDAV-Method': 'MKCALENDAR',
      'X-WebDAV-Collection': 'cal',
      'X-WebDAV-Path': 'abc',
      'Content-Type': 'application/xml; charset=utf-8',
      'X-JMAP-Cookie-Slot': '2',
    });
    expect(init.body).toContain('<C:comp name="VEVENT"/>');
  });

  it('reports anything but 201 as not created', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 405 }));
    await expect(mkCalendarCollection({ collectionName: 'abc', displayName: 'Work', components: ['VEVENT'] })).resolves.toBe(false);
  });
});

describe('parseCalendarCollectionComponents', () => {
  it('parses multistatus XML with supported-calendar-component-set', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/cal/sebastian/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/cal/sebastian/cal-events/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Termine</D:displayname>
        <C:supported-calendar-component-set>
          <C:comp name="VEVENT"/>
        </C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/cal/sebastian/cal-tasks/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>MeineTestAufgaben</D:displayname>
        <C:supported-calendar-component-set>
          <C:comp name="VTODO"/>
        </C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

    const map = parseCalendarCollectionComponents(xml);
    expect(map['cal-events']).toEqual(['VEVENT']);
    expect(map['cal-tasks']).toEqual(['VTODO']);
    expect(map['sebastian']).toBeUndefined(); // Root is skipped
  });

  it('parses calendar collections even with short paths (e.g. /cal/user/colId) when resourcetype is calendar', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/cal/user/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/cal/user/short-path-tasks/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <C:supported-calendar-component-set>
          <C:comp name="VTODO"/>
        </C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

    const map = parseCalendarCollectionComponents(xml);
    expect(map['short-path-tasks']).toEqual(['VTODO']);
    expect(map['user']).toBeUndefined();
  });
});

describe('fetchCalendarCollectionComponents', () => {
  it('sends PROPFIND Depth: 1 to cal collection and returns component map', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/cal/user/tasks-123/</D:href>
    <D:propstat>
      <D:prop>
        <C:supported-calendar-component-set>
          <C:comp name="VTODO"/>
        </C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

    fetchSpy.mockResolvedValueOnce(new Response(xml, {
      status: 207,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    }));

    const result = await fetchCalendarCollectionComponents();
    expect(result['tasks-123']).toEqual(['VTODO']);
    expect(fetchSpy).toHaveBeenCalledWith('/api/webdav', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'X-WebDAV-Method': 'PROPFIND',
        'X-WebDAV-Collection': 'cal',
        'Depth': '1',
      }),
    }));
  });

  it('returns empty map on error or non-207 status', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const result = await fetchCalendarCollectionComponents();
    expect(result).toEqual({});
  });

  it('uses the explicitly passed account headers instead of the active-account default', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('<D:multistatus xmlns:D="DAV:"/>', { status: 207 }));
    await fetchCalendarCollectionComponents({ 'X-JMAP-Cookie-Slot': '5' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // The mocked getActiveAccountSlotHeaders() would return slot '2' (see the
    // module mock above) - the explicit override must win, since this is the
    // path used when scanning an account other than the active one.
    expect(init.headers).toMatchObject({ 'X-JMAP-Cookie-Slot': '5' });
  });
});


// Stalwart names a CalDAV collection by its path (a phone's UUID, or the
// random name mkCalendarCollection picks), not by the JMAP calendar id, and
// gives no property linking the two: the display name is the link, used only
// where it names one collection and one calendar (recorded on Stalwart 1.0.3:
// path x1794141216003 = JMAP id c).
describe('davComponentsFor', () => {
  const multistatus = (rows: Array<[string, string, string[]]>) => `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:caldav">${rows.map(([path, name, comps]) => `
<D:response><D:href>/dav/cal/alice%40example.org/${path}/</D:href><D:propstat><D:prop>
<D:displayname>${name}</D:displayname><D:resourcetype><D:collection/><A:calendar/></D:resourcetype>
<A:supported-calendar-component-set>${comps.map((c) => `<A:comp name="${c}"/>`).join('')}</A:supported-calendar-component-set>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('')}
</D:multistatus>`;

  const dav = parseCalendarCollectionComponents(multistatus([
    ['default', 'Calendar', ['VEVENT', 'VTODO']],
    ['x1794141216003', 'Errands', ['VTODO']],
    ['a1', 'Twin', ['VTODO']],
    ['a2', 'Twin', ['VEVENT']],
  ]));
  const calendars = [
    { id: 'b', name: 'Calendar' },
    { id: 'c', name: 'Errands' },
    { id: 'd', name: 'Twin' },
    { id: 'e', name: 'Twin' },
  ];

  it('finds a collection whose path is not the calendar id by its display name', () => {
    expect(davComponentsFor(calendars[1], dav, calendars)).toEqual(['VTODO']);
    expect(davComponentsFor(calendars[0], dav, calendars)).toEqual(['VEVENT', 'VTODO']);
  });

  it('still finds a collection by its path when that is the calendar id', () => {
    expect(davComponentsFor({ id: 'x1794141216003', name: 'Renamed' }, dav, [])).toEqual(['VTODO']);
  });

  it('guesses nothing when the name is not unique', () => {
    expect(davComponentsFor(calendars[2], dav, calendars)).toBeUndefined();
  });
});

// Stalwart's Depth 1 listing of a calendar home also holds the collections
// other accounts share with the user (recorded on Stalwart 0.16 and 1.0).
describe('collections shared into the calendar home', () => {
  const homeXml = `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:caldav">
<D:response><D:href>/dav/cal/usera%40example.org/</D:href><D:propstat><D:prop><A:supported-calendar-component-set/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat><D:propstat><D:prop><D:displayname>User A</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/dav/cal/usera%40example.org/default/</D:href><D:propstat><D:prop><D:displayname>Calendar</D:displayname><D:resourcetype><D:collection/><A:calendar/></D:resourcetype><A:supported-calendar-component-set><A:comp name="VEVENT"/><A:comp name="VTODO"/></A:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/dav/cal/usera%40example.org/x1794141216003/</D:href><D:propstat><D:prop><D:displayname>Errands</D:displayname><D:resourcetype><D:collection/><A:calendar/></D:resourcetype><A:supported-calendar-component-set><A:comp name="VTODO"/></A:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/dav/cal/team%40example.org/default/</D:href><D:propstat><D:prop><D:displayname>Errands</D:displayname><D:resourcetype><D:collection/><A:calendar/></D:resourcetype><A:supported-calendar-component-set><A:comp name="VTODO"/></A:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
  const requestUri = 'https://mail.example.org/dav/cal/usera%40example.org/';
  const calendars = [{ id: 'b', name: 'Calendar' }, { id: 'c', name: 'Errands' }];

  it("keeps only the home's own collections when the home is known", () => {
    const dav = parseCalendarCollectionComponents(homeXml, requestUri);
    // The team's "default" doesn't overwrite the user's own.
    expect(dav['default']).toEqual(['VEVENT', 'VTODO']);
    // The team's "Errands" doesn't make the user's own one ambiguous.
    expect(davComponentsFor(calendars[1], dav, calendars)).toEqual(['VTODO']);
  });

  it('reads the home from the proxy response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(homeXml, {
      status: 207,
      headers: { 'X-WebDAV-Request-URI': requestUri },
    }));
    const dav = await fetchCalendarCollectionComponents();
    expect(dav['default']).toEqual(['VEVENT', 'VTODO']);
    expect(davComponentsFor(calendars[1], dav, calendars)).toEqual(['VTODO']);
  });

  it('finds the home behind a reverse proxy that mounts the server under a prefix', () => {
    const dav = parseCalendarCollectionComponents(homeXml, 'https://example.org/mail/dav/cal/usera%40example.org/');
    expect(dav['default']).toEqual(['VEVENT', 'VTODO']);
    expect(davComponentsFor(calendars[1], dav, calendars)).toEqual(['VTODO']);
  });

  // The proxy builds the home from the login as typed; Stalwart writes its own spelling.
  it('finds the home when the login is typed in other case or encoded otherwise', () => {
    for (const uri of [
      'https://mail.example.org/dav/cal/UserA%40Example.org/',
      'https://mail.example.org/dav/cal/UserA@Example.org/',
      'https://mail.example.org/DAV/Cal/usera%40example.org/',
    ]) {
      const dav = parseCalendarCollectionComponents(homeXml, uri);
      expect(dav['default']).toEqual(['VEVENT', 'VTODO']);
      expect(davComponentsFor(calendars[1], dav, calendars)).toEqual(['VTODO']);
    }
    const raw = homeXml.replace(/usera%40example\.org/g, 'usera@example.org');
    expect(parseCalendarCollectionComponents(raw, 'https://mail.example.org/dav/cal/UserA%40example.org/')['x1794141216003']).toEqual(['VTODO']);
  });

  it('still leaves out the collections of another account in other case', () => {
    const dav = parseCalendarCollectionComponents(homeXml, 'https://mail.example.org/dav/cal/Team%40Example.org/');
    expect(dav['x1794141216003']).toBeUndefined();
    expect(dav['default']).toEqual(['VTODO']);
  });

  it('skips an href it cannot decode and reads the rest', () => {
    const xml = homeXml.replace('/dav/cal/usera%40example.org/default/', '/dav/cal/usera%40example.org/bad%E0%A4%A/');
    expect(parseCalendarCollectionComponents(xml, requestUri)['x1794141216003']).toEqual(['VTODO']);
  });
});

describe('fetchCalendarCollectionComponents limits', () => {
  afterEach(() => {
    lite.on = false;
  });

  it('asks nothing in Lite, which has no WebDAV proxy', async () => {
    lite.on = true;
    await expect(fetchCalendarCollectionComponents()).resolves.toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gives up on a server that does not answer, so the calendar list still loads', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('<D:multistatus xmlns:D="DAV:"/>', { status: 207 }));
    await fetchCalendarCollectionComponents();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
