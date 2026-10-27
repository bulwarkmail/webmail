import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock the environment variable
beforeAll(() => {
  vi.stubEnv('DEV_MOCK_JMAP', 'true');
  // Inlined from DEV_MOCK_JMAP at build time in a real build.
  vi.stubEnv('NEXT_PUBLIC_DEV_MOCK_JMAP', 'true');
});

// We test via dynamic import to get a fresh module with env set
async function loadRoute() {
  // Clear module cache to reset mock email state between test suites
  const mod = await import('../../app/api/dev-jmap/[...path]/route');
  return mod;
}

function makeRequest(url: string, options?: globalThis.RequestInit): Request {
  return new Request(url, options);
}

describe('dev-jmap mock server', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GET: (request: any, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let POST: (request: any, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;

  beforeAll(async () => {
    const mod = await loadRoute();
    GET = mod.GET as typeof GET;
    POST = mod.POST as typeof POST;
  });

  describe('GET /.well-known/jmap', () => {
    it('should return session object with capabilities', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/.well-known/jmap', {
        headers: { host: 'localhost:3000' },
      });
      const res = await GET(req, { params: Promise.resolve({ path: ['.well-known', 'jmap'] }) });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.capabilities).toBeDefined();
      expect(data.capabilities['urn:ietf:params:jmap:core']).toBeDefined();
      expect(data.accounts).toBeDefined();
      expect(data.apiUrl).toContain('/api/dev-jmap/api');
      expect(data.downloadUrl).toContain('/download/');
      expect(data.eventSourceUrl).toContain('/eventsource');
    });
  });

  describe('GET /download', () => {
    it('should return a response with attachment disposition', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/download/dev-account-001/blob-att-001/Q1-Bericht.pdf?accept=application/pdf', {
        headers: { host: 'localhost:3000' },
      });
      const res = await GET(req, { params: Promise.resolve({ path: ['download', 'dev-account-001', 'blob-att-001', 'Q1-Bericht.pdf'] }) });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
      expect(res.headers.get('Content-Disposition')).toContain('Q1-Bericht.pdf');
    });
  });

  describe('GET /eventsource', () => {
    it('should return text/event-stream content type', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/eventsource?types=*&ping=30', {
        headers: { host: 'localhost:3000' },
      });
      const res = await GET(req, { params: Promise.resolve({ path: ['eventsource'] }) });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
    });
  });

  describe('POST /api - Mailbox/get', () => {
    it('should return list of mailboxes', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [['Mailbox/get', { accountId: 'dev-account-001' }, 'c0']],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(data.methodResponses).toBeDefined();
      expect(data.methodResponses[0][0]).toBe('Mailbox/get');
      expect(data.methodResponses[0][1].list.length).toBeGreaterThan(0);
      const inbox = data.methodResponses[0][1].list.find((m: { role: string }) => m.role === 'inbox');
      expect(inbox).toBeDefined();
    });
  });

  describe('POST /api - back-references', () => {
    it('resolves a wildcard path across a list (RFC 8620 §3.7)', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [
            ['Email/query', { accountId: 'dev-account-001', filter: { inMailbox: 'mb-inbox' }, limit: 3 }, '0'],
            ['Email/get', { accountId: 'dev-account-001', '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['threadId'] }, '1'],
            ['Thread/get', { accountId: 'dev-account-001', '#ids': { resultOf: '1', name: 'Email/get', path: '/list/*/threadId' } }, '2'],
          ],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      const threadIds = data.methodResponses[1][1].list.map((e: { threadId: string }) => e.threadId);
      expect(threadIds.length).toBeGreaterThan(0);
      expect(data.methodResponses[2][0]).toBe('Thread/get');
      expect(data.methodResponses[2][1].list.map((t: { id: string }) => t.id).sort()).toEqual([...new Set<string>(threadIds)].sort());
    });
  });

  describe('POST /api - Email/query', () => {
    it('should filter by mailbox', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [['Email/query', { accountId: 'dev-account-001', filter: { inMailbox: 'mb-inbox' } }, 'c0']],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(data.methodResponses[0][0]).toBe('Email/query');
      expect(data.methodResponses[0][1].ids.length).toBeGreaterThan(0);
    });

    it('should filter by text search', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [['Email/query', { accountId: 'dev-account-001', filter: { text: 'willkommen' } }, 'c0']],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(data.methodResponses[0][1].ids.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api - text conditions as the app sends them', () => {
    // Search sends each quoted phrase and each `word*` as its own condition.
    async function queryIds(method: string, filter: Record<string, unknown>): Promise<string[]> {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({ methodCalls: [[method, { accountId: 'dev-account-001', filter }, 'c0']] }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      return data.methodResponses[0][1].ids;
    }

    it('matches a quoted phrase ANDed with a prefix in Email/query', async () => {
      const found = await queryIds('Email/query', { operator: 'AND', conditions: [{ text: '"sprint priorities"' }, { text: 'wee*' }] });
      expect(found.length).toBeGreaterThan(0);
      expect(await queryIds('Email/query', { operator: 'AND', conditions: [{ text: '"priorities sprint"' }, { text: 'wee*' }] })).toEqual([]);
    });

    it('resolves an AND of bounds and text parts in CalendarEvent/query', async () => {
      expect(await queryIds('CalendarEvent/query', {
        operator: 'AND',
        conditions: [
          { after: '2000-01-01T00:00:00Z' },
          { before: '2100-01-01T23:59:59Z' },
          { text: '"sprint planning"' },
          { text: 'plan*' },
        ],
      })).toEqual(['evt-002']);
    });

    it('resolves an AND of text parts in ContactCard/query', async () => {
      expect(await queryIds('ContactCard/query', {
        operator: 'AND',
        conditions: [{ text: '"sophie müller"' }, { text: 'euro*' }],
      })).toEqual(['contact-001']);
    });
  });

  describe('POST /api - Email/get', () => {
    it('should return emails by ids', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [['Email/get', { accountId: 'dev-account-001', ids: ['email-001'] }, 'c0']],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(data.methodResponses[0][0]).toBe('Email/get');
      expect(data.methodResponses[0][1].list).toHaveLength(1);
      expect(data.methodResponses[0][1].list[0].subject).toContain('Willkommen');
    });

    it('should filter properties when specified', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [['Email/get', { accountId: 'dev-account-001', ids: ['email-001'], properties: ['id', 'subject'] }, 'c0']],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      const email = data.methodResponses[0][1].list[0];
      expect(email.id).toBe('email-001');
      expect(email.subject).toBeDefined();
      expect(email.bodyValues).toBeUndefined();
    });
  });

  describe('POST /api - Email/set', () => {
    it('should update email keywords', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [['Email/set', { accountId: 'dev-account-001', update: { 'email-001': { 'keywords/$seen': true } } }, 'c0']],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(data.methodResponses[0][0]).toBe('Email/set');
      expect(data.methodResponses[0][1].updated['email-001']).toBeNull();
    });
  });

  describe('POST /api - Identity/get', () => {
    it('should return identities', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [['Identity/get', { accountId: 'dev-account-001' }, 'c0']],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(data.methodResponses[0][0]).toBe('Identity/get');
      expect(data.methodResponses[0][1].list.length).toBeGreaterThan(0);
      expect(data.methodResponses[0][1].list[0].email).toBe('dev@localhost');
    });
  });

  describe('POST /api - unknown method', () => {
    it('should return error for unknown methods', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [['FakeMethod/get', {}, 'c0']],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(data.methodResponses[0][0]).toBe('error');
      expect(data.methodResponses[0][1].type).toBe('unknownMethod');
    });
  });

  describe('POST /api - PushSubscription lifecycle', () => {
    it('creates, verifies, lists, and destroys a push subscription', async () => {
      const relayFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 202 }),
      );

      try {
        const createReq = makeRequest('http://localhost:3000/api/dev-jmap/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
          body: JSON.stringify({
            methodCalls: [['PushSubscription/set', {
              create: {
                new: {
                  deviceClientId: 'browser-device-1',
                  url: 'https://notifications.relay.bulwarkmail.org/api/push/jmap/browser-device-1',
                  types: ['Email'],
                  expires: '2030-01-01T00:00:00.000Z',
                },
              },
            }, 'c0']],
          }),
        });
        const createRes = await POST(createReq, { params: Promise.resolve({ path: ['api'] }) });
        const createData = await createRes.json();
        const id = createData.methodResponses[0][1].created.new.id as string;
        const verificationBody = JSON.parse(
          String(relayFetch.mock.calls[0]?.[1]?.body),
        ) as { verificationCode: string };

        expect(id).toMatch(/^push-/);
        expect(relayFetch).toHaveBeenCalledOnce();

        const verifyReq = makeRequest('http://localhost:3000/api/dev-jmap/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
          body: JSON.stringify({
            methodCalls: [['PushSubscription/set', {
              update: { [id]: { verificationCode: verificationBody.verificationCode } },
            }, 'v0']],
          }),
        });
        const verifyRes = await POST(verifyReq, { params: Promise.resolve({ path: ['api'] }) });
        const verifyData = await verifyRes.json();
        expect(verifyData.methodResponses[0][1].updated[id]).toBeNull();

        const getReq = makeRequest('http://localhost:3000/api/dev-jmap/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
          body: JSON.stringify({
            methodCalls: [['PushSubscription/get', { ids: [id] }, 'g0']],
          }),
        });
        const getRes = await POST(getReq, { params: Promise.resolve({ path: ['api'] }) });
        const getData = await getRes.json();
        expect(getData.methodResponses[0][1].list).toEqual([
          expect.objectContaining({ id, deviceClientId: 'browser-device-1' }),
        ]);

        const destroyReq = makeRequest('http://localhost:3000/api/dev-jmap/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
          body: JSON.stringify({
            methodCalls: [['PushSubscription/set', { destroy: [id] }, 'd0']],
          }),
        });
        const destroyRes = await POST(destroyReq, { params: Promise.resolve({ path: ['api'] }) });
        const destroyData = await destroyRes.json();
        expect(destroyData.methodResponses[0][1].destroyed).toEqual([id]);
      } finally {
        relayFetch.mockRestore();
      }
    });
  });

  describe('POST /api - EmailSubmission destroy', () => {
    async function call(methodCalls: unknown[]) {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({ methodCalls }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      return (await res.json()).methodResponses;
    }

    it('removes a canceled scheduled submission and reports unknown ids as notFound', async () => {
      const [[, created]] = await call([['EmailSubmission/set', {
        accountId: 'dev-account-001',
        create: { s1: { emailId: 'email-001', identityId: 'identity-001', envelope: { mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '3600' } }, rcptTo: [] } } },
      }, 'c0']]);
      const id = created.created.s1.id as string;
      await call([['EmailSubmission/set', { accountId: 'dev-account-001', update: { [id]: { undoStatus: 'canceled' } } }, 'u0']]);

      const [[, result]] = await call([['EmailSubmission/set', { accountId: 'dev-account-001', destroy: [id, 'submission-unknown'] }, 'd0']]);

      expect(result.destroyed).toEqual([id]);
      expect(result.notDestroyed).toEqual({ 'submission-unknown': { type: 'notFound' } });
      const [[, got]] = await call([['EmailSubmission/get', { accountId: 'dev-account-001', ids: [id] }, 'g0']]);
      expect(got.list).toEqual([]);
    });
  });

  describe('POST /api - back-references', () => {
    it('should resolve #ids from Email/query result', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [
            ['Email/query', { accountId: 'dev-account-001', filter: { inMailbox: 'mb-inbox' }, limit: 2 }, 'q0'],
            ['Email/get', { accountId: 'dev-account-001', '#ids': { resultOf: 'q0', name: 'Email/query', path: 'ids' }, properties: ['id', 'subject'] }, 'g0'],
          ],
        }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(data.methodResponses).toHaveLength(2);
      expect(data.methodResponses[1][0]).toBe('Email/get');
      // The get should have resolved ids from the query
      expect(data.methodResponses[1][1].list.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api - invalid request', () => {
    it('should return 400 for missing methodCalls', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({}),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api - request limits', () => {
    it('should refuse a request with more method calls than it advertises', async () => {
      const methodCalls = Array.from({ length: 17 }, (_, i) => [
        'Email/query',
        { accountId: 'dev-account-001', limit: 0, calculateTotal: true },
        `c${i}`,
      ]);
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({ methodCalls }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.type).toBe('urn:ietf:params:jmap:error:limit');
      expect(data.limit).toBe('maxCallsInRequest');
    });

    it('should reject an over-sized /set with requestTooLarge', async () => {
      const destroy = Array.from({ length: 501 }, (_, i) => `email-${i}`);
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({ methodCalls: [['Email/set', { accountId: 'dev-account-001', destroy }, '0']] }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.methodResponses[0][0]).toBe('error');
      expect(data.methodResponses[0][1].type).toBe('requestTooLarge');
    });

    it('should reject an over-sized /get with requestTooLarge', async () => {
      const ids = Array.from({ length: 501 }, (_, i) => `email-${i}`);
      const req = makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({ methodCalls: [['Email/get', { accountId: 'dev-account-001', ids }, '0']] }),
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['api'] }) });
      const data = await res.json();
      expect(data.methodResponses[0][0]).toBe('error');
      expect(data.methodResponses[0][1].type).toBe('requestTooLarge');
    });
  });

  describe('POST /upload', () => {
    it('should return a fake blob response', async () => {
      const req = makeRequest('http://localhost:3000/api/dev-jmap/upload/dev-account-001/', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '1024', host: 'localhost:3000' },
        body: 'fake-data',
      });
      const res = await POST(req, { params: Promise.resolve({ path: ['upload', 'dev-account-001'] }) });
      const data = await res.json();
      expect(data.accountId).toBe('dev-account-001');
      expect(data.blobId).toBeDefined();
      expect(data.type).toBe('image/png');
    });
  });

  describe('POST /api - FileNode/set', () => {
    it('reads the size of a new file off its blob, like a real server', async () => {
      const upload = await POST(makeRequest('http://localhost:3000/api/dev-jmap/upload/dev-account-001/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', host: 'localhost:3000' },
        body: 'hello',
      }), { params: Promise.resolve({ path: ['upload', 'dev-account-001'] }) });
      const { blobId } = await upload.json();

      const res = await POST(makeRequest('http://localhost:3000/api/dev-jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({
          methodCalls: [['FileNode/set', {
            accountId: 'dev-account-001',
            create: {
              uploaded: { name: 'hello.txt', type: 'text/plain', blobId },
              // A copy points at the blob of a seeded node.
              copied: { name: 'copy.pdf', type: 'application/pdf', blobId: 'demo-blob-quarterly-report' },
            },
          }, '0']],
        }),
      }), { params: Promise.resolve({ path: ['api'] }) });
      const { created } = (await res.json()).methodResponses[0][1];
      expect(created.uploaded.size).toBe(5);
      expect(created.copied.size).toBe(40644);
    });

    it('keeps a folder that still holds something unless onDestroyRemoveChildren is set, like a real server', async () => {
      const fileNodeSet = async (args: Record<string, unknown>) => {
        const res = await POST(makeRequest('http://localhost:3000/api/dev-jmap/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
          body: JSON.stringify({ methodCalls: [['FileNode/set', { accountId: 'dev-account-001', ...args }, '0']] }),
        }), { params: Promise.resolve({ path: ['api'] }) });
        return (await res.json()).methodResponses[0][1];
      };
      const folder = (await fileNodeSet({ create: { f: { name: 'Rollback test' } } })).created.f.id;
      const inside = (await fileNodeSet({ create: { x: { name: 'x.pdf', type: 'application/pdf', blobId: 'demo-blob-quarterly-report', parentId: folder } } })).created.x.id;

      expect((await fileNodeSet({ destroy: [folder] })).notDestroyed[folder].type).toBe('nodeHasChildren');
      expect((await fileNodeSet({ destroy: [inside] })).destroyed).toEqual([inside]);
      expect((await fileNodeSet({ destroy: [folder] })).destroyed).toEqual([folder]);
    });
  });
});

// The mock accepts any password; a build made without DEV_MOCK_JMAP (every
// release image) must not be able to switch it on at runtime.
describe('dev-jmap mock in a build made without it', () => {
  it('stays off even when DEV_MOCK_JMAP is set at runtime', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEV_MOCK_JMAP', '');
    try {
      const { GET } = await loadRoute();
      const req = makeRequest('http://localhost:3000/api/dev-jmap/.well-known/jmap', {
        headers: { host: 'localhost:3000' },
      });
      const res = await GET(req as never, { params: Promise.resolve({ path: ['.well-known', 'jmap'] }) });
      expect(res.status).toBe(404);
    } finally {
      vi.stubEnv('NEXT_PUBLIC_DEV_MOCK_JMAP', 'true');
    }
  });
});
