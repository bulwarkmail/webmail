import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { closePluginFilesOf, currentFileView, registerFileViewerHost, resetFileViews } from '../plugin-sandbox/file-viewer';
import { bytesMatchType, viewerFileName } from '../plugin-sandbox/host-api-file-viewer';

const policy = vi.hoisted(() => ({ print: true }));

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../device-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../device-policy')>()),
  canPrintAnywhere: () => policy.print,
}));

const { dispatchApiCall } = await import('../plugin-sandbox/host-api');

// api.ui.openFile and api.ui.print with a PDF: a file the plugin made opens in
// the app's own file preview. Only PDF and raster images, by their bytes; never
// HTML or SVG on the app's origin.

const PLUGIN: InstalledPlugin = {
  id: 'akte', name: 'Akte', version: '1.0.0', author: 'test', description: '',
  // No permission at all: the user sees the file and decides what to do with it.
  type: 'ui-extension', permissions: [], grantedPermissions: [], entrypoint: 'index.js',
  enabled: true, status: 'running', settings: {},
};
const call = (method: string, ...args: unknown[]) => dispatchApiCall(PLUGIN, method, args);

const text = (s: string) => new TextEncoder().encode(s);
const PDF = text('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HTML = text('<!DOCTYPE html><script>alert(document.cookie)</script>');
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

let unregister: () => void;
beforeEach(() => {
  resetPluginRateLimits();
  resetFileViews();
  policy.print = true;
  unregister = registerFileViewerHost();
});
afterEach(() => unregister());

describe('api.ui.openFile', () => {
  it('shows a PDF in the preview, as a Blob of its own type', async () => {
    expect(await call('ui.openFile', { content: PDF.slice().buffer, filename: 'Akte 01-2026.pdf', contentType: 'application/pdf' })).toBe(true);
    const view = currentFileView()!;
    expect(view).toMatchObject({ pluginId: 'akte', name: 'Akte 01-2026.pdf', print: false });
    expect(view.blob.type).toBe('application/pdf');
    expect(view.blob.size).toBe(PDF.byteLength);
    expect(new TextDecoder().decode(await view.blob.arrayBuffer())).toBe(new TextDecoder().decode(PDF));
  });

  it('takes the bytes as a typed array or a Blob too, and images', async () => {
    await call('ui.openFile', { content: PNG, filename: 'scan', contentType: 'image/png' });
    expect(currentFileView()!.name).toBe('scan.png');
    await call('ui.openFile', { content: new Blob([PDF]), filename: 'b.pdf', contentType: 'application/pdf; charset=binary' });
    expect(currentFileView()!.blob.type).toBe('application/pdf');
  });

  it('refuses HTML, SVG and scripts, also when they claim to be a PDF', async () => {
    await expect(call('ui.openFile', { content: HTML, filename: 'x.html', contentType: 'text/html' })).rejects.toThrow(/can't be opened/);
    await expect(call('ui.openFile', { content: SVG, filename: 'x.svg', contentType: 'image/svg+xml' })).rejects.toThrow(/can't be opened/);
    await expect(call('ui.openFile', { content: text('alert(1)'), filename: 'x.js', contentType: 'text/javascript' })).rejects.toThrow(/can't be opened/);
    await expect(call('ui.openFile', { content: HTML, filename: 'x.pdf', contentType: 'application/pdf' })).rejects.toThrow(/not a application\/pdf file/);
    await expect(call('ui.openFile', { content: SVG, filename: 'x.png', contentType: 'image/png' })).rejects.toThrow(/not a image\/png file/);
    // Text is no file of bytes, whatever it holds.
    await expect(call('ui.openFile', { content: '%PDF-1.7', filename: 'x.pdf', contentType: 'application/pdf' })).rejects.toThrow(/content must be bytes/);
    expect(currentFileView()).toBeNull();
  });

  it('refuses an empty or too big file, and unknown fields', async () => {
    await expect(call('ui.openFile', { content: new Uint8Array(0), filename: 'x.pdf', contentType: 'application/pdf' })).rejects.toThrow(/empty/);
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    big.set(PDF);
    await expect(call('ui.openFile', { content: big, filename: 'x.pdf', contentType: 'application/pdf' })).rejects.toThrow(/bigger than 25 MiB/);
    await expect(call('ui.openFile', { content: PDF, filename: 'x.pdf', contentType: 'application/pdf', url: 'https://x' })).rejects.toThrow(/unknown property "url"/);
  });

  it('gives the file a name without a path or a disguised extension', () => {
    expect(viewerFileName('../../etc/passwd', 'application/pdf')).toBe('_.._etc_passwd.pdf');
    expect(viewerFileName('report.html', 'application/pdf')).toBe('report.html.pdf');
    expect(viewerFileName('Bild.JPEG', 'image/jpeg')).toBe('Bild.JPEG');
    expect(viewerFileName('\u202egnp.exe', 'image/png')).toBe('gnp.exe.png');
    expect(viewerFileName('', 'application/pdf')).toBe('file.pdf');
  });

  it('knows the files by their first bytes', () => {
    expect(bytesMatchType(PDF, 'application/pdf')).toBe(true);
    expect(bytesMatchType(new Uint8Array([0xef, 0xbb, 0xbf, ...PDF]), 'application/pdf')).toBe(true);
    expect(bytesMatchType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg')).toBe(true);
    expect(bytesMatchType(text('GIF89a'), 'image/gif')).toBe(true);
    expect(bytesMatchType(text('RIFF\0\0\0\0WEBPVP8 '), 'image/webp')).toBe(true);
    expect(bytesMatchType(text('RIFF\0\0\0\0AVI '), 'image/webp')).toBe(false);
    expect(bytesMatchType(PNG, 'application/pdf')).toBe(false);
  });

  it('opens five files a minute', async () => {
    for (let i = 0; i < 5; i++) await call('ui.openFile', { content: PDF, filename: `${i}.pdf`, contentType: 'application/pdf' });
    await expect(call('ui.openFile', { content: PDF, filename: 'x.pdf', contentType: 'application/pdf' })).rejects.toThrow(/at most 5 files a minute/);
  });

  it('says so where no preview can show it, and drops the file when the plugin stops', async () => {
    await call('ui.openFile', { content: PDF, filename: 'x.pdf', contentType: 'application/pdf' });
    closePluginFilesOf('other');
    expect(currentFileView()).not.toBeNull();
    closePluginFilesOf('akte');
    expect(currentFileView()).toBeNull();
    unregister();
    await expect(call('ui.openFile', { content: PDF, filename: 'x.pdf', contentType: 'application/pdf' })).rejects.toThrow(/no file preview in this window/);
    unregister = registerFileViewerHost();
  });
});

describe('api.ui.print with a PDF', () => {
  it('opens the PDF in the preview to print it', async () => {
    expect(await call('ui.print', { title: 'Alles drucken', pdf: PDF })).toBe(true);
    expect(currentFileView()).toMatchObject({ name: 'Alles drucken.pdf', print: true });
  });

  it('takes a PDF only, and either html or pdf', async () => {
    await expect(call('ui.print', { pdf: PNG })).rejects.toThrow(/not a application\/pdf file/);
    await expect(call('ui.print', { pdf: PDF, html: '<p>x</p>' })).rejects.toThrow(/either html or pdf/);
    await expect(call('ui.print', { title: 'x' })).rejects.toThrow(/either html or pdf/);
    expect(currentFileView()).toBeNull();
  });

  it('prints nothing while the organisation turns printing off, and counts against three a minute', async () => {
    policy.print = false;
    await expect(call('ui.print', { pdf: PDF })).rejects.toThrow(/printing is turned off/);
    expect(currentFileView()).toBeNull();
    policy.print = true;
    for (let i = 0; i < 3; i++) await call('ui.print', { pdf: PDF });
    await expect(call('ui.print', { pdf: PDF })).rejects.toThrow(/at most 3 times a minute/);
  });
});
