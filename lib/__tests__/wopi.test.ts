import { describe, it, expect, vi } from 'vitest';
import { parseWopiDiscovery, buildWopiActionUrl } from '@/lib/wopi/discovery';
import { mintWopiToken, verifyWopiToken, wopiDocumentId } from '@/lib/wopi/token';

// token.ts encrypts via lib/auth/crypto, whose key comes solely from
// getSessionSecret() - mock that seam like auth-crypto.test.ts does.
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 'x'.repeat(32),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

const DISCOVERY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<wopi-discovery>
  <net-zone name="external-http">
    <app name="writer">
      <action default="true" ext="odt" name="edit" urlsrc="http://office.example:9980/browser/abc123/cool.html?"/>
      <action ext="docx" name="edit" urlsrc="http://office.example:9980/browser/abc123/cool.html?"/>
      <action ext="doc" name="view" urlsrc="http://office.example:9980/browser/abc123/cool.html?"/>
    </app>
    <app name="calc">
      <action default="true" ext="ods" name="edit" urlsrc="http://office.example:9980/browser/abc123/cool.html?"/>
      <action ext="xlsx" name="edit" urlsrc="http://office.example:9980/browser/abc123/cool.html?"/>
    </app>
    <app name="application/vnd.openxmlformats-officedocument.wordprocessingml.document">
      <action default="true" ext="" name="edit" urlsrc="http://office.example:9980/browser/abc123/cool.html?"/>
    </app>
  </net-zone>
</wopi-discovery>`;

describe('parseWopiDiscovery', () => {
  it('maps extensions to edit/view urlsrc', () => {
    const actions = parseWopiDiscovery(DISCOVERY_XML);
    expect(Object.keys(actions.edit).sort()).toEqual(['docx', 'ods', 'odt', 'xlsx']);
    expect(actions.view).toHaveProperty('doc');
    expect(actions.edit.docx).toContain('/cool.html');
  });

  it('ignores actions without an extension and tolerates junk', () => {
    expect(parseWopiDiscovery('<notxml>')).toEqual({ edit: {}, view: {} });
    expect(parseWopiDiscovery('')).toEqual({ edit: {}, view: {} });
  });
});

describe('buildWopiActionUrl', () => {
  it('appends WOPISrc to a urlsrc ending in ?', () => {
    const url = buildWopiActionUrl(
      'http://office.example/browser/abc/cool.html?',
      'http://mail.example/api/wopi/files/f1',
    );
    expect(url).toBe(
      'http://office.example/browser/abc/cool.html?WOPISrc=http%3A%2F%2Fmail.example%2Fapi%2Fwopi%2Ffiles%2Ff1',
    );
  });

  it('drops optional <placeholder&> groups and joins with &', () => {
    const url = buildWopiActionUrl(
      'http://office.example/cool.html?lang=en<ui=UI_LLCC&><rs=DC_LLCC&>',
      'http://mail.example/api/wopi/files/f1',
    );
    expect(url).toBe(
      'http://office.example/cool.html?lang=en&WOPISrc=http%3A%2F%2Fmail.example%2Fapi%2Fwopi%2Ffiles%2Ff1',
    );
  });

  it('starts the query string when urlsrc has none', () => {
    const url = buildWopiActionUrl('http://office.example/edit', 'http://h/api/wopi/files/f1');
    expect(url).toContain('/edit?WOPISrc=');
  });
});

describe('mintWopiToken / verifyWopiToken', () => {
  const payload = {
    serverUrl: 'https://mail.example.com',
    authHeader: 'Basic dXNlcjpwYXNz',
    username: 'user@example.com',
    accountId: 'c',
    fileId: 'f42',
    canWrite: true,
    origin: 'https://webmail.example.com',
  };

  const docId = wopiDocumentId(payload);

  it('round-trips and binds to the document id', () => {
    const { token, expiresAt } = mintWopiToken(payload);
    expect(expiresAt).toBeGreaterThan(Date.now());
    const verified = verifyWopiToken(token, docId);
    expect(verified).toMatchObject(payload);
    // A token for one file must not authorize another.
    expect(verifyWopiToken(token, wopiDocumentId({ ...payload, fileId: 'other-file' }))).toBeNull();
    // Nor is the raw FileNode id accepted in the URL any more.
    expect(verifyWopiToken(token, 'f42')).toBeNull();
  });

  it('rejects garbage, empty and expired tokens', () => {
    expect(verifyWopiToken(null, docId)).toBeNull();
    expect(verifyWopiToken('not-a-token', docId)).toBeNull();
    const { token } = mintWopiToken(payload);
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(realNow() + 7 * 60 * 60 * 1000);
    try {
      expect(verifyWopiToken(token, docId)).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('carries read-only attachment metadata (#1047)', () => {
    const attachment = {
      ...payload,
      kind: 'attachment' as const,
      fileId: 'Gblob123',
      name: 'Quote.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 12345,
      canWrite: false,
    };
    const { token } = mintWopiToken(attachment);
    expect(verifyWopiToken(token, wopiDocumentId(attachment))).toMatchObject(attachment);
    // A blob id that happens to equal a FileNode id is a different document.
    expect(wopiDocumentId(attachment)).not.toBe(wopiDocumentId({ ...payload, fileId: 'Gblob123' }));
  });
});

describe('wopiDocumentId', () => {
  const base = { serverUrl: 'https://mail.example.com', accountId: 'c', fileId: 'b' };

  // WOPI clients key open sessions by WOPISrc: two accounts' node "b" must
  // not share one, or the second user is served the first user's document.
  it('differs per account and per server for the same node id', () => {
    const id = wopiDocumentId(base);
    expect(wopiDocumentId({ ...base, accountId: 'd' })).not.toBe(id);
    expect(wopiDocumentId({ ...base, serverUrl: 'https://other.example.com' })).not.toBe(id);
  });

  it('is stable, URL-safe and treats a missing kind as a file', () => {
    const id = wopiDocumentId(base);
    expect(wopiDocumentId({ ...base })).toBe(id);
    expect(wopiDocumentId({ ...base, kind: 'file' })).toBe(id);
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
