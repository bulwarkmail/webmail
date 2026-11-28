import { isOpenableLinkHref } from '@/lib/email-sanitization';

/**
 * The open-link page: where a message link goes in a browser that skips the
 * frame's click listener (lib/email-frame-links.ts). The link points at
 * `/open-link#<token>` and opens that page in a new tab; the page asks the
 * tab that holds the token over a BroadcastChannel, and that tab runs the
 * usual gate (onBeforeExternalLink and the href check, resolveExternalLink)
 * and answers with the address to open, or null. The page opens nothing it
 * wasn't told to, and nothing at all when no tab answers.
 *
 * The real address never reaches the frame, so a link the browser follows
 * by itself (a click, a middle-click, Enter, "Open in New Tab") lands on
 * this page and nowhere else.
 */

export const LINK_GATE_CHANNEL = 'bulwark:link-gate';

/** The page asks: which address does this token open? */
export interface LinkGateRequest { type: 'open-link'; id: string; token: string }
/** The tab holding the token answers at once, before the gate has decided. */
export interface LinkGateAck { type: 'open-link-ack'; id: string }
/** And again with the gate's answer: the address to open, or null. */
export interface LinkGateResult { type: 'open-link-result'; id: string; href: string | null }

export function isLinkGateRequest(value: unknown): value is LinkGateRequest {
  const v = value as Partial<LinkGateRequest> | null;
  return !!v && v.type === 'open-link' && typeof v.id === 'string' && typeof v.token === 'string';
}

/** How long the page waits for a tab to say it holds the token. */
export const LINK_GATE_ACK_TIMEOUT_MS = 4000;

export type LinkGateOutcome =
  | { kind: 'checking' }
  | { kind: 'open'; href: string }
  | { kind: 'not-opened' };

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Ask the tabs of this origin about `token`. `onUpdate` gets 'checking'
 * once a tab holds it, then 'open' with the address or 'not-opened'. With
 * no answer in time, no BroadcastChannel or an address the href check
 * rejects, it is 'not-opened'. Returns a function that stops listening.
 */
export function requestLinkGate(
  token: string,
  onUpdate: (outcome: LinkGateOutcome) => void,
  timeoutMs = LINK_GATE_ACK_TIMEOUT_MS,
): () => void {
  if (!token || typeof BroadcastChannel === 'undefined') {
    onUpdate({ kind: 'not-opened' });
    return () => {};
  }
  const id = newId();
  const channel = new BroadcastChannel(LINK_GATE_CHANNEL);
  let acked = false;
  let done = false;
  const finish = (outcome: LinkGateOutcome) => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    channel.close();
    onUpdate(outcome);
  };
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; id?: unknown; href?: unknown } | null;
    if (!data || data.id !== id) return;
    if (data.type === 'open-link-ack') {
      if (!acked) {
        acked = true;
        window.clearTimeout(timer);
        onUpdate({ kind: 'checking' });
      }
      return;
    }
    if (data.type === 'open-link-result') {
      const href = typeof data.href === 'string' ? data.href : null;
      finish(href && isOpenableLinkHref(href) ? { kind: 'open', href } : { kind: 'not-opened' });
    }
  };
  const timer = window.setTimeout(() => { if (!acked) finish({ kind: 'not-opened' }); }, timeoutMs);
  const request: LinkGateRequest = { type: 'open-link', id, token };
  channel.postMessage(request);
  return () => {
    done = true;
    window.clearTimeout(timer);
    channel.close();
  };
}

/** The token in an open-link address (`#<token>`), or ''. */
export function linkGateToken(hash: string): string {
  const token = hash.startsWith('#') ? hash.slice(1) : hash;
  return /^[A-Za-z0-9-]{8,64}$/.test(token) ? token : '';
}
