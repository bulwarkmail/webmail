import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailHooks, pluginErrorTracker } from '../plugin-hooks';
import { linkParamsFrom, splitLinkParams } from '../plugin-link-params';
import { deliverLinkParams } from '../plugin-composer-hooks';
import { parseMailto } from '../protocol-handlers/mailto';
import { parseLaunchLanding, stripLandingParams } from '../launch-handoff';

// Parameters for plugins in a link that opens the composer:
// `x-<plugin id>-<name>=<value>` in a mailto: link or a Bulwark link goes to
// that plugin only, as onComposeFromLink({ composerId, params }), prefix gone.

afterEach(() => {
  emailHooks.onComposeFromLink.clear();
  pluginErrorTracker.resetAll();
});

describe('plugin parameters in a mailto: link', () => {
  it('keeps the x- parameters beside the fields, and nothing of them in the message', () => {
    const parsed = parseMailto('mailto:a@b.de?subject=Mahnung&x-akte-case=01%2F2026&X-Akte-Court=AG%20Berlin&body=Hallo')!;
    expect(parsed).toMatchObject({ to: ['a@b.de'], subject: 'Mahnung', body: 'Hallo' });
    expect(parsed.linkParams).toEqual({ 'x-akte-case': '01/2026', 'x-akte-court': 'AG Berlin' });
  });

  it('has none without x- parameters', () => {
    expect(parseMailto('mailto:a@b.de?subject=Hi')!.linkParams).toBeUndefined();
  });

  it('drops odd names and control characters, and caps size and count', () => {
    const params = linkParamsFrom([
      ['x-akte-case', 'a\r\nb\u0000c'],
      ['x-akte-case', 'second'],
      ['x-', 'no name'],
      ['x-akte-<b>', 'markup'],
      ['xakte-case', 'no dash'],
      ['x-akte-long', 'v'.repeat(5000)],
    ])!;
    expect(params['x-akte-case']).toBe('abc');
    expect(Object.keys(params)).toEqual(['x-akte-case', 'x-akte-long']);
    expect(params['x-akte-long']).toHaveLength(2048);
    const many = linkParamsFrom(Array.from({ length: 80 }, (_, i) => [`x-akte-p${i}`, `${i}`] as const))!;
    expect(Object.keys(many)).toHaveLength(50);
  });
});

describe('plugin parameters in a Bulwark link', () => {
  it('ride along with a new message from the address bar, and leave it with it', () => {
    expect(parseLaunchLanding('?compose=1&x-akte-case=01%2F2026&other=1', '')).toEqual({ type: 'new-message', linkParams: { 'x-akte-case': '01/2026' } });
    expect(parseLaunchLanding('?compose=1', '')).toEqual({ type: 'new-message' });
    expect(stripLandingParams('?compose=1&x-akte-case=01%2F2026&other=1', '').search).toBe('?other=1');
  });
});

describe('who gets which parameter', () => {
  it('gives each plugin its own, without the prefix, and the longest id wins', () => {
    const split = splitLinkParams(
      { 'x-akte-case': '1', 'x-e-invoice-number': '2', 'x-e-other': '3', 'x-unknown-thing': '4', 'x-akte-': '5' },
      ['akte', 'e', 'e-invoice'],
    );
    expect(Object.fromEntries(split)).toEqual({
      akte: { case: '1' },
      'e-invoice': { number: '2' },
      e: { other: '3' },
    });
  });

  it('tells only the plugin a parameter is for, once the plugins have started', async () => {
    const akte = vi.fn();
    const other = vi.fn();
    emailHooks.onComposeFromLink.register('akte', akte);
    emailHooks.onComposeFromLink.register('other', other);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const done = deliverLinkParams('composer-1', { 'x-akte-case': '01/2026', 'x-akte-court': 'AG Berlin', 'x-third-a': 'b' }, () => ready);
    await Promise.resolve();
    expect(akte).not.toHaveBeenCalled();
    started();
    await done;
    expect(akte).toHaveBeenCalledTimes(1);
    expect(akte).toHaveBeenCalledWith({ composerId: 'composer-1', params: { case: '01/2026', court: 'AG Berlin' } });
    expect(other).not.toHaveBeenCalled();
  });
});
