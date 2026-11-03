// @vitest-environment node
/** The real FetchTransport against a real local HTTP server: what a fake can't tell about bodies. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { FetchTransport, TransportError, type StoreSession } from '../engine/transport';
import { mailArea } from '../mail';
import { FakeJmapMail } from './helpers/fake-jmap-mail';
import { FAKE_SESSION, JMAP_ACCOUNT } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const BIG = 3 * 1024 * 1024 + 7;
let server: Server;
let base: string;
let auth: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    auth.push(String(req.headers.authorization));
    if (req.url?.includes('/whole/')) {
      res.writeHead(200, { 'Content-Length': String(BIG) });
      res.end(Buffer.alloc(BIG, 5));
      return;
    }
    if (req.url?.includes('/broken/')) {
      // Promises more than it sends, then the connection goes.
      res.writeHead(200, { 'Content-Length': '500000' });
      res.write(Buffer.alloc(1000, 1), () => res.destroy());
      return;
    }
    if (req.url?.includes('/refused/')) {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

function transport(): FetchTransport {
  const session: StoreSession = { ...FAKE_SESSION, downloadUrl: `${base}/d/{accountId}/{blobId}/{name}?type={type}` };
  return new FetchTransport({ session: () => session, auth: () => 'Basic x', refreshAuth: async () => 'Basic x' });
}

describe('FetchTransport against a real server', () => {
  it('hands a file over in pieces, none of them the whole file', async () => {
    const pieces: number[] = [];
    let bytes = 0;
    await transport().downloadStream('j', 'whole', 'application/pdf', 'a.pdf', (part) => {
      pieces.push(part.length);
      bytes += part.length;
      expect(part.every((value) => value === 5)).toBe(true);
    });
    expect(bytes).toBe(BIG);
    expect(pieces.length).toBeGreaterThan(1);
    expect(Math.max(...pieces)).toBeLessThan(BIG);
    expect(auth.at(-1)).toBe('Basic x');
  });

  it('still gives a whole file from download', async () => {
    expect((await transport().download('j', 'whole', 'application/pdf', 'a.pdf')).length).toBe(BIG);
  });

  it('calls a connection that drops halfway an interrupted transfer, in both', async () => {
    const stream = await transport().downloadStream('j', 'broken', 'a/b', 'a', () => {}).catch((error) => error);
    expect(stream).toBeInstanceOf(TransportError);
    expect(stream).toMatchObject({ kind: 'network', interrupted: true });
    const whole = await transport().download('j', 'broken', 'a/b', 'a').catch((error) => error);
    expect(whole).toMatchObject({ kind: 'network', interrupted: true });
  });

  it('says what the server said for a refusal', async () => {
    expect(await transport().downloadStream('j', 'refused', 'a/b', 'a', () => {}).catch((error) => error)).toMatchObject({ kind: 'http', status: 404 });
  });

  it('lets an error from the sink out as it is, and ends the download', async () => {
    class Stop extends Error {}
    await expect(transport().downloadStream('j', 'whole', 'a/b', 'a', () => { throw new Stop(); })).rejects.toBeInstanceOf(Stop);
  });
});

describe('the attachment pass with it', () => {
  it('keeps a file that comes in pieces, and carries on past one that breaks', async () => {
    const real = transport();
    const fake = new FakeJmapMail({ mailboxes: [{ id: 'inbox', role: 'inbox' }] });
    fake.addEmail({ id: 'first', blobId: 'refused', size: 500_000_000, receivedAt: new Date(Date.UTC(2026, 9, 3)).toISOString(), attachments: [{ partId: '2', blobId: 'broken', size: 500000, type: 'a/b', name: 'broken' }] as never });
    fake.addEmail({ id: 'second', blobId: 'refused', size: 500_000_000, receivedAt: new Date(Date.UTC(2026, 9, 2)).toISOString(), attachments: [{ partId: '2', blobId: 'whole', size: BIG, type: 'a/b', name: 'whole' }] as never });
    const db = openMemoryStore();
    const engine = new AccountEngine({
      account: 'a',
      db,
      session: FAKE_SESSION,
      transport: { request: (calls) => fake.request(calls), download: real.download.bind(real), downloadStream: real.downloadStream.bind(real), upload: real.upload.bind(real) },
      areas: [mailArea],
      scope: { ...DEFAULT_SCOPE, days: null },
      sleep: async () => {},
    });
    await engine.requestSync();
    expect(await engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'broken' })).toBeNull();
    const kept = await engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'whole' }) as { blob: Blob };
    expect(kept.blob.size).toBe(BIG);
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blob_chunk WHERE blob_id = 'whole'")?.n)).toBe(4);
    // Not given up on: a broken transfer says nothing about the file.
    expect(db.get<{ refused: number }>("SELECT refused FROM email_part WHERE blob_id = 'broken'")?.refused).toBe(0);
  });
});
