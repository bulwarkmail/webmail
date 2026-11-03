import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as publicApi from '@/lib/attachment-text';
import { extractText, MAX_EXTRACTIONS_AT_ONCE } from '@/lib/attachment-text';
import { setPdfLoader, type PdfLib } from '@/lib/attachment-text/pdf';

// How the extraction loads and runs: a Blob in (Files), at most two at a
// time, the readers loaded only when the host reads an attachment.

const root = path.resolve(__dirname, '../../..');
const source = (file: string) => readFileSync(path.join(root, file), 'utf8');

afterEach(() => setPdfLoader());

describe('extractText', () => {
  it('reads a Blob, and answers too_big for a large one without reading it', async () => {
    expect(await extractText(new Blob(['Notes from Files']), { name: 'notes.txt' })).toMatchObject({ status: 'ok', text: 'Notes from Files' });
    let read = false;
    const big = new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]);
    big.arrayBuffer = async () => { read = true; return new ArrayBuffer(0); };
    expect(await extractText(big, { name: 'big.txt' })).toMatchObject({ status: 'too_big' });
    expect(read).toBe(false);
  });

  it('runs at most two extractions at a time; the others wait their turn', async () => {
    expect(MAX_EXTRACTIONS_AT_ONCE).toBe(2);
    let active = 0;
    let most = 0;
    const release: (() => void)[] = [];
    const lib: PdfLib = {
      getDocument: () => {
        active++;
        most = Math.max(most, active);
        return {
          promise: new Promise((resolve) => release.push(() => resolve({
            numPages: 1,
            getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'A page with enough text on it to count' }] }) }),
          }))),
          destroy: async () => { active--; },
        };
      },
    };
    setPdfLoader(async () => lib);
    const reads = Array.from({ length: 5 }, () => extractText(new Uint8Array([37, 80, 68, 70]), { name: 'a.pdf' }));
    for (let round = 0; round < 10; round++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      release.splice(0).forEach((go) => go());
    }
    const done = await Promise.all(reads);
    expect(done.every((r) => r.status === 'ok')).toBe(true);
    expect(most).toBe(2);
  });

  it('keeps the pdf.js test seam out of the public module', () => {
    expect('setPdfLoader' in publicApi).toBe(false);
  });
});

describe('loading', () => {
  it('the host loads the readers only when an attachment is read', () => {
    const b = source('lib/plugin-sandbox/assistant/b.ts');
    expect(b).not.toMatch(/^import [^;]* from '@\/lib\/attachment-text';/m);
    expect(b).toContain("await import('@/lib/attachment-text')");
  });

  it('the sandbox uses the runtime\'s own network timeout for reads', () => {
    const runtime = source('lib/plugin-sandbox/assistant/b.runtime.ts');
    expect(runtime).toContain("import { NETWORK_API_TIMEOUT_MS } from '../api-timeouts';");
    expect(runtime).not.toMatch(/\d{2,3}_000/);
    expect(source('lib/plugin-sandbox/runtime.tsx')).toContain("from './api-timeouts';");
  });
});
