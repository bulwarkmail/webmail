// The open-link page asks the reader's tab what a routed message link opens
// and opens only that: the reader runs onBeforeExternalLink and the href
// check, and a token no tab holds opens nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { LINK_GATE_CHANNEL, isLinkGateRequest, linkGateToken, requestLinkGate, type LinkGateOutcome } from '@/lib/link-gate';
import { gatedLinkHref, resetLinkGateHolder } from '@/lib/link-gate-holder';
import { clearAllHooks, uiHooks } from '@/lib/plugin-hooks';

function ask(href: string | null, timeoutMs = 2000): Promise<LinkGateOutcome[]> {
  const token = href ? linkGateToken(new URL(href).hash) : 'not-a-held-token-123';
  return new Promise((resolve) => {
    const seen: LinkGateOutcome[] = [];
    requestLinkGate(token, (outcome) => {
      seen.push(outcome);
      if (outcome.kind !== 'checking') resolve(seen);
    }, timeoutMs);
  });
}

afterEach(() => {
  clearAllHooks();
  resetLinkGateHolder();
});

describe('open-link page', () => {
  it('opens the address the reader lets through', async () => {
    const href = gatedLinkHref({ href: 'https://site.example/a', emailId: 'e1' });
    expect(await ask(href)).toEqual([{ kind: 'checking' }, { kind: 'open', href: 'https://site.example/a' }]);
  });

  it('asks onBeforeExternalLink and opens its rewrite', async () => {
    const seen: unknown[] = [];
    uiHooks.onBeforeExternalLink.register('p1', (ctx) => { seen.push(ctx); return { href: 'https://proxy.example/?u=a' }; });
    const href = gatedLinkHref({ href: 'https://site.example/a', emailId: 'e1', text: 'web' });
    expect((await ask(href)).at(-1)).toEqual({ kind: 'open', href: 'https://proxy.example/?u=a' });
    expect(seen).toEqual([expect.objectContaining({ href: 'https://site.example/a', emailId: 'e1', text: 'web' })]);
  });

  it('opens nothing when a plugin stops the link', async () => {
    uiHooks.onBeforeExternalLink.register('p1', () => false);
    const href = gatedLinkHref({ href: 'https://site.example/a' });
    expect((await ask(href)).at(-1)).toEqual({ kind: 'not-opened' });
  });

  it('opens nothing for a token no tab holds', async () => {
    expect(await ask(null, 100)).toEqual([{ kind: 'not-opened' }]);
  });

  it('opens nothing the href check refuses, whatever a tab answers', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    const tab = new BroadcastChannel(LINK_GATE_CHANNEL);
    tab.onmessage = (event: MessageEvent) => {
      if (!isLinkGateRequest(event.data) || event.data.token !== token) return;
      tab.postMessage({ type: 'open-link-ack', id: event.data.id });
      tab.postMessage({ type: 'open-link-result', id: event.data.id, href: '/settings/accounts' });
    };
    try {
      const outcome = await new Promise((resolve) => {
        requestLinkGate(token, (o) => { if (o.kind !== 'checking') resolve(o); }, 2000);
      });
      expect(outcome).toEqual({ kind: 'not-opened' });
    } finally {
      tab.close();
    }
  });

  it('only takes a token from the fragment', () => {
    expect(linkGateToken('#0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
    expect(linkGateToken('#<img src=x>')).toBe('');
    expect(linkGateToken('')).toBe('');
  });
});
