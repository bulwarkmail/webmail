import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { ZipWriter } from '@/lib/mail-export/zip-writer';
import { crc32 } from '@/lib/mail-export/crc32';
import { listZipEntries, readZipEntry, streamZipEntry } from '@/lib/mail-import/zip-reader';

const enc = new TextEncoder();
const dec = new TextDecoder();
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

describe('crc32', () => {
  it('matches the reference value and streams', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(enc.encode('6789'), crc32(enc.encode('12345')))).toBe(0xcbf43926);
  });
});

describe('ZipWriter', () => {
  async function build(fill: (z: ZipWriter) => Promise<void>) {
    const chunks: Uint8Array[] = [];
    const z = new ZipWriter(async (c) => { chunks.push(c.slice()); });
    await fill(z);
    await z.finish();
    return join(chunks);
  }

  it('writes files, folders and a streamed entry that other readers open', async () => {
    const big = 'From MAILER-DAEMON x\n'.repeat(5000);
    const zip = await build(async (z) => {
      await z.addFile('Inbox/0001 Hello.eml', enc.encode('Subject: Hello\r\n\r\nbody'), new Date(2020, 4, 5, 10, 11, 12));
      await z.addDirectory('Empty');
      await z.addFile('Prüfung/ä.eml', enc.encode('x'.repeat(1000)));
      const s = await z.openStream('Archive.mbox');
      await s.write(enc.encode(big.slice(0, 1000)));
      await s.write(enc.encode(big.slice(1000)));
      await s.close();
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['Archive.mbox', 'Empty/', 'Inbox/0001 Hello.eml', 'Prüfung/ä.eml']);
    expect(strFromU8(files['Inbox/0001 Hello.eml'])).toBe('Subject: Hello\r\n\r\nbody');
    expect(strFromU8(files['Archive.mbox'])).toBe(big);
  });

  it('is read back by the importer, whole and in chunks', async () => {
    const big = enc.encode('line of mail\n'.repeat(20000));
    const zip = await build(async (z) => {
      await z.addFile('a.eml', enc.encode('A'));
      const s = await z.openStream('b.mbox');
      for (let i = 0; i < big.length; i += 7000) await s.write(big.subarray(i, i + 7000));
      await s.close();
    });
    const file = new Blob([zip]);
    const entries = await listZipEntries(file);
    expect(entries.map((e) => [e.name, e.size])).toEqual([['a.eml', 1], ['b.mbox', big.length]]);
    expect(dec.decode(await readZipEntry(file, entries[0]))).toBe('A');
    const parts: Uint8Array[] = [];
    for await (const c of streamZipEntry(file, entries[1], 4096)) parts.push(c);
    // Compared as text: jsdom and Node each have their own Uint8Array.
    expect(dec.decode(join(parts))).toBe(dec.decode(big));
  });

  it('writes Zip64 records past 65,535 entries', async () => {
    const zip = await build(async (z) => {
      for (let i = 0; i < 65_540; i++) await z.addFile(`${i}`, new Uint8Array(0));
    });
    // The classic end record says "see Zip64", and the Zip64 one has the count.
    const entries = await listZipEntries(new Blob([zip]));
    expect(entries).toHaveLength(65_540);
    expect(entries[65_539].name).toBe('65539');
  }, 60_000);

  it('announces Zip64 in the local header of a streamed entry and writes a 64-bit descriptor', async () => {
    const zip = await build(async (z) => {
      const s = await z.openStream('a.mbox');
      await s.write(enc.encode('hello'));
      await s.close();
    });
    const v = new DataView(zip.buffer);
    expect(v.getUint16(4, true)).toBe(45);
    expect(v.getUint32(18, true)).toBe(0xffffffff);
    expect(v.getUint32(22, true)).toBe(0xffffffff);
    const nameLength = v.getUint16(26, true);
    expect(v.getUint16(28, true)).toBe(20);
    expect(v.getUint16(30 + nameLength, true)).toBe(0x0001);
    // Readers that use the central directory still open it.
    expect(strFromU8(unzipSync(zip)['a.mbox'])).toBe('hello');
    const entries = await listZipEntries(new Blob([zip]));
    expect(dec.decode(await readZipEntry(new Blob([zip]), entries[0]))).toBe('hello');
  });

  it('writes the sizes of a streamed entry past 4 GB in 64 bits', async () => {
    // Counts the bytes instead of keeping them; only headers and records are kept.
    let offset = 0;
    const small: { at: number; bytes: Uint8Array }[] = [];
    const z = new ZipWriter(async (c) => {
      if (c.length < 4096) small.push({ at: offset, bytes: c.slice() });
      offset += c.length;
    }, { compressStreams: false, checksum: () => 0x12345678 });
    const chunk = new Uint8Array(64 * 1024 * 1024);
    const s = await z.openStream('huge.mbox');
    for (let i = 0; i < 66; i++) await s.write(chunk);
    await s.close();
    await z.finish();
    const size = 66 * 64 * 1024 * 1024;
    expect(size).toBeGreaterThan(0xffffffff);
    const find = (sig: number) => small.find((r) => new DataView(r.bytes.buffer).getUint32(0, true) === sig)!;
    const u64 = (dv: DataView, at: number) => dv.getUint32(at, true) + dv.getUint32(at + 4, true) * 0x1_0000_0000;
    const descriptor = new DataView(find(0x08074b50).bytes.buffer);
    expect(descriptor.byteLength).toBe(24);
    expect(u64(descriptor, 8)).toBe(size);
    expect(u64(descriptor, 16)).toBe(size);
    const central = new DataView(find(0x02014b50).bytes.buffer);
    expect(central.getUint32(20, true)).toBe(0xffffffff);
    expect(central.getUint32(24, true)).toBe(0xffffffff);
    const extraAt = 46 + central.getUint16(28, true);
    expect(central.getUint16(extraAt, true)).toBe(0x0001);
    expect(u64(central, extraAt + 4)).toBe(size);
    expect(u64(central, extraAt + 12)).toBe(size);
    // The central directory starts past 4 GB, so the Zip64 end record is there too.
    expect(find(0x06064b50)).toBeTruthy();
  }, 120_000);
});

describe('zip reader', () => {
  async function oneFile() {
    const parts: Uint8Array[] = [];
    const z = new ZipWriter(async (c) => { parts.push(c.slice()); });
    await z.addFile('a.eml', enc.encode('Subject: x\r\n\r\n' + 'body '.repeat(100)));
    await z.finish();
    return join(parts);
  }
  const centralAt = (zip: Uint8Array) => {
    for (let i = 0; i < zip.length - 4; i++) if (new DataView(zip.buffer, zip.byteOffset).getUint32(i, true) === 0x02014b50) return i;
    throw new Error('no central directory');
  };

  it('refuses an encrypted entry instead of importing garbage', async () => {
    const zip = await oneFile();
    const at = centralAt(zip);
    zip[at + 8] |= 1;
    const entries = await listZipEntries(new Blob([zip]));
    expect(entries[0].encrypted).toBe(true);
    await expect(readZipEntry(new Blob([zip]), entries[0])).rejects.toMatchObject({ name: 'ZipFormatError' });
  });

  it('refuses an entry whose declared size is wrong instead of cutting it short', async () => {
    const zip = await oneFile();
    const at = centralAt(zip);
    new DataView(zip.buffer, zip.byteOffset).setUint32(at + 24, 10, true);
    const entries = await listZipEntries(new Blob([zip]));
    await expect(readZipEntry(new Blob([zip]), entries[0])).rejects.toMatchObject({ name: 'ZipFormatError' });
  });
});
