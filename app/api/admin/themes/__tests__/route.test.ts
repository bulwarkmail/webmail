/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));

let policy: Record<string, unknown>;
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn(),
    getPolicy: vi.fn(() => policy),
    setPolicy: vi.fn(async (p: Record<string, unknown>) => { policy = p; }),
    updatePolicy: vi.fn(async (change: (p: Record<string, unknown>) => Record<string, unknown> | undefined) => { policy = change(policy) ?? policy; }),
  },
}));
const saved: Array<{ theme: Record<string, unknown>; css: string; skin: string | null }> = [];
vi.mock('@/lib/admin/plugin-registry', () => ({
  deleteTheme: vi.fn(async () => true),
  themeCSSResolver: vi.fn(async () => () => null),
  saveTheme: vi.fn(async (theme: Record<string, unknown>, css: string, skin: string | null) => { saved.push({ theme, css, skin }); }),
  getTheme: vi.fn(async () => null),
  getThemeRegistry: vi.fn(async () => ({ themes: [] })),
}));

import JSZip from 'jszip';
import { DELETE, POST } from '../route';

function del(id: string) {
  return DELETE(new NextRequest('http://localhost/api/admin/themes', {
    method: 'DELETE',
    body: JSON.stringify({ id }),
    headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => {
  saved.length = 0;
  policy = { forceEnabledThemes: ['corp', 'other'], forceEnabledPlugins: [] };
});

describe('DELETE /api/admin/themes', () => {
  it('stops forcing a theme once it is deleted', async () => {
    const res = await del('corp');

    expect(res.status).toBe(200);
    expect(policy.forceEnabledThemes).toEqual(['other']);
  });
});

describe('POST /api/admin/themes', () => {
  it('refuses a theme.css that unpacks past the limit', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'big', name: 'Big', version: '1.0.0', author: 'a', type: 'theme', variants: ['light'] }));
    zip.file('theme.css', new Uint8Array(30 * 1024 * 1024));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const form = new FormData();
    form.append('file', new File([bytes as BlobPart], 't.zip'));

    const res = await POST(new NextRequest('http://localhost/api/admin/themes', { method: 'POST', body: form }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/once unpacked/);
  });
});

describe('POST /api/admin/themes with Theme API v2', () => {
  it('installs a tokens-only theme with a skin', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'ocean', name: 'Ocean', version: '1.0.0', author: 'a', type: 'theme', variants: ['light', 'dark'],
      apiVersion: 2, tokens: { light: { '--color-primary': '#0066cc' }, dark: { '--color-primary': '#66aaff' } },
    }));
    zip.file('skin.css', '.message-list { border-radius: 8px; }');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const form = new FormData();
    form.append('file', new File([bytes as BlobPart], 'ocean.zip'));

    const res = await POST(new NextRequest('http://localhost/api/admin/themes', { method: 'POST', body: form }));

    expect(res.status).toBe(200);
    expect(saved[0].css).toContain('#0066cc');
    expect(saved[0].skin).toContain('border-radius');
  });
});
