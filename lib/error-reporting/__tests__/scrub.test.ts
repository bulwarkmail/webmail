// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { scrubFramePath, scrubJmapErrorType, scrubMethodName, scrubName, scrubText } from '../scrub';
import { routeGroup, scrubRoutePath } from '@/lib/route-groups';

// Mail content planted where it could end up in an error: none of it may
// survive scrubbing.
const SUBJECT = 'Merger plans for Acme Q3';
const ADDRESS = 'ceo.private@acme-corp.example';
const FOLDER = 'Acquisition Talks';
const FILE = 'term-sheet-final.pdf';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlMTIzNDU2';

function expectClean(text: string) {
  for (const planted of [SUBJECT, ADDRESS, FOLDER, FILE, TOKEN, 'Merger', 'acme-corp', 'Acquisition', 'term-sheet']) {
    expect(text).not.toContain(planted);
  }
}

describe('scrubText', () => {
  it('removes a quoted subject, an address and a file name from a message', () => {
    const out = scrubText(`Failed to move "${SUBJECT}" from ${ADDRESS} with attachment ${FILE}`);
    expectClean(out);
    expect(out).toBe('Failed to move "…" from [email] with attachment [file]');
  });

  it('removes text in every kind of quote, but keeps contractions', () => {
    expect(scrubText(`can't open 'Merger' or “Merger” or ‘Merger’ or «Merger» or \`Merger\``))
      .toBe("can't open '…' or “…” or ‘…’ or «…» or `…`");
  });

  it('removes URLs whole, with their query strings', () => {
    const out = scrubText(`fetch https://mail.acme-corp.example/jmap/download/abc/${FILE}?token=${TOKEN} failed`);
    expectClean(out);
    expect(out).toBe('fetch [url] failed');
  });

  it('removes credentials, JWTs, key=value pairs and random-looking ids', () => {
    expect(scrubText(`Authorization: Bearer ${TOKEN}`)).toBe('Authorization: Bearer [token]');
    expect(scrubText(`token ${TOKEN} expired`)).toBe('token [token] expired');
    expect(scrubText('cookie session=abc123def; theme=dark')).toBe('cookie session=[redacted]; theme=[redacted]');
    expect(scrubText('blob Ma1b2c3d4e5f6a7b8c9d0e1f2a3b4 missing')).toBe('blob [id] missing');
  });

  it('keeps only the first line and drops a server answer after the status', () => {
    expect(scrubText(`Request failed: 400 - {"description":"${SUBJECT}"}`)).toBe('Request failed: 400');
    expect(scrubText(`Something broke\n${SUBJECT}\n${ADDRESS}`)).toBe('Something broke');
  });

  it('keeps engine messages readable', () => {
    expect(scrubText('Cannot read properties of undefined (reading \'id\')')).toBe('Cannot read properties of undefined (reading \'…\')');
    // Minified identifiers go too; the resolved stack names the code.
    expect(scrubText('e.map is not a function')).toBe('… is not a function');
  });

  it('removes unquoted free text such as a folder name or a subject', () => {
    const out = scrubText('Cannot move message from ' + ADDRESS + ' to ' + FOLDER + ': ' + SUBJECT.toLowerCase());
    expectClean(out);
    expect(out).toBe('Cannot move message from [email] to …: … for …');
  });

  it('caps the length', () => {
    expect(scrubText('x '.repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe('route paths in breadcrumbs and reports', () => {
  it('keeps the area only, never folder names or ids', () => {
    const path = `/de/mail/folder/${encodeURIComponent(FOLDER)}/Mabc123?q=${encodeURIComponent(SUBJECT)}`;
    const out = scrubRoutePath(path);
    expectClean(decodeURIComponent(out));
    expect(out).toBe('/mail/…');
  });

  it('removes the base path and maps unknown areas and API routes to fixed names', () => {
    expect(scrubRoutePath('/webmail/en/calendar', '/webmail')).toBe('/calendar');
    expect(scrubRoutePath(`/en/${encodeURIComponent(FOLDER)}`)).toBe('/other');
    expect(scrubRoutePath('/api/wopi/files/abc/contents')).toBe('/api/wopi/…');
    expect(routeGroup(`/api/${FOLDER}`)).toBe('api:other');
    expect(routeGroup('/_next/static/chunks/a.js')).toBe('static');
    expect(routeGroup('/')).toBe('page:home');
  });
});

describe('frame paths', () => {
  it('drops the origin, base path, query and fragment', () => {
    expect(scrubFramePath('https://mail.acme-corp.example/webmail/_next/static/chunks/12-ab.js?dpl=x#y')).toBe('/_next/static/chunks/12-ab.js');
    expect(scrubFramePath('/home/alice/bulwark/.next/server/chunks/ssr/a.js')).toBe('/.next/server/chunks/ssr/a.js');
    expect(scrubFramePath('/home/alice/bulwark/node_modules/next/dist/x.js')).toBe('node_modules/next/dist/x.js');
    expect(scrubFramePath('node:internal/process/task_queues')).toBe('node:internal/process/task_queues');
  });

  it('turns anything else into [other]', () => {
    expect(scrubFramePath('chrome-extension://abc/content.js')).toBe('[other]');
    expect(scrubFramePath(`https://acme-corp.example/${FILE}`)).toBe('[other]');
    expect(scrubFramePath('blob:https://x/1')).toBe('[other]');
  });
});

describe('names', () => {
  it('keeps identifiers only', () => {
    expect(scrubName('TypeError')).toBe('TypeError');
    expect(scrubName(SUBJECT)).toBe('Error');
    expect(scrubMethodName('Email/get')).toBe('Email/get');
    expect(scrubMethodName(SUBJECT)).toBe('Unknown/method');
    expect(scrubJmapErrorType('overQuota')).toBe('overQuota');
    expect(scrubJmapErrorType(ADDRESS)).toBe('unknown');
  });
});
