import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock the environment variable
beforeAll(() => {
  vi.stubEnv('DEV_MOCK_JMAP', 'true');
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
});
