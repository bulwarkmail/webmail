import { withBasePath } from '@/lib/browser-navigation';
import { IS_LITE } from '@/lib/lite';
import { isOpenableLinkHref } from '@/lib/email-sanitization';
import type { FrameLinkRoute } from '@/lib/email-frame-links';
import { linkText, resolveExternalLink } from '@/lib/plugin-hook-result';
import type { ExternalLinkContext } from '@/lib/plugin-types';
import { LINK_GATE_CHANNEL, isLinkGateRequest, type LinkGateAck, type LinkGateResult } from '@/lib/link-gate';

/**
 * The reader's side of the open-link page (lib/link-gate.ts): it keeps the
 * links it handed out a token for and answers the page with what
 * resolveExternalLink makes of them.
 */

/** Tokens kept per tab; the oldest go first. A mail rarely has more than a few hundred links. */
const MAX_HELD = 5000;

const held = new Map<string, ExternalLinkContext>();
let channel: BroadcastChannel | null = null;

function token(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function listen(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  const opened = new BroadcastChannel(LINK_GATE_CHANNEL);
  opened.onmessage = (event: MessageEvent) => {
    if (!isLinkGateRequest(event.data)) return;
    const { id } = event.data;
    const ctx = held.get(event.data.token);
    if (!ctx) return;
    const ack: LinkGateAck = { type: 'open-link-ack', id };
    opened.postMessage(ack);
    void resolveExternalLink(ctx)
      .catch(() => null)
      .then((href) => {
        const result: LinkGateResult = { type: 'open-link-result', id, href };
        opened.postMessage(result);
      });
  };
  channel = opened;
  return opened;
}

/**
 * An address on the open-link page that opens `ctx` through the gate, or
 * null where the page couldn't ask this tab (no BroadcastChannel): the
 * link then stays without an href.
 */
export function gatedLinkHref(ctx: ExternalLinkContext): string | null {
  if (typeof window === 'undefined' || !listen()) return null;
  const id = token();
  held.set(id, ctx);
  if (held.size > MAX_HELD) {
    const oldest = held.keys().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
  const page = new URL(withBasePath(IS_LITE ? '/open-link/' : '/open-link'), window.location.href);
  page.hash = id;
  return page.href;
}

/** Tests: forget every token and close the channel. */
export function resetLinkGateHolder(): void {
  held.clear();
  channel?.close();
  channel = null;
}

/**
 * The route for a message frame's links where its click listener doesn't
 * run (releaseFrameLinks): what the reader's gate lets through, as far as
 * it can be decided without the click. In-page anchors and mailto: keep
 * their address. Web links and external protocol handlers go through the
 * open-link page. Links to a cid: part (blob:), relative paths, data: and
 * everything else the href check refuses get none.
 */
export function gateMessageLink(emailId: string | undefined): FrameLinkRoute {
  return (link, href) => {
    if (href.startsWith('#') || /^mailto:/i.test(href)) return href;
    if (href.startsWith('blob:') || !isOpenableLinkHref(href)) return null;
    return gatedLinkHref({ href, target: '_blank', emailId, text: linkText(link) });
  };
}
