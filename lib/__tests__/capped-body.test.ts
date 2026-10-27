import { describe, it, expect } from 'vitest';
import { UpstreamBodyTooLargeError, readBodyCapped, readJsonCapped, readTextCapped } from '@/lib/security/capped-body';
import { endlessResponse } from './helpers/endless-body';

const MB = 1024 * 1024;

describe('capped upstream body reads', () => {
  it('stops reading a body that streams past the cap', async () => {
    const { response, pulled } = endlessResponse(200);
    await expect(readTextCapped(response, 5 * MB)).rejects.toBeInstanceOf(UpstreamBodyTooLargeError);
    expect(pulled()).toBeLessThanOrEqual(7);
  });

  it('refuses a declared Content-Length over the cap without reading', async () => {
    const { response, pulled } = endlessResponse(10, { headers: { 'Content-Length': String(10 * MB) } });
    expect(await readBodyCapped(response, MB)).toBeNull();
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it('reads a body under the cap like text() and json() do', async () => {
    expect(await readTextCapped(new Response(String.fromCharCode(0xfeff) + 'grüße'), MB)).toBe('grüße');
    expect(await readJsonCapped(new Response('{"a":[1,2]}'), MB)).toEqual({ a: [1, 2] });
    const { response } = endlessResponse(3);
    expect((await readTextCapped(response, 3 * MB)).length).toBe(3 * MB);
  });

  it('rejects bad JSON the way json() does', async () => {
    await expect(readJsonCapped(new Response('not json'), MB)).rejects.toBeInstanceOf(SyntaxError);
  });
});
