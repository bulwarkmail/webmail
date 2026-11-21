/**
 * RFC 5322 §3.6.4 reply threading.
 *
 * Computes the In-Reply-To and References headers an outgoing reply must
 * carry so MUAs can stitch the conversation back together.
 *
 *   In-Reply-To = parent.Message-ID
 *   References  = parent.References (if any) + parent.Message-ID
 *
 * Bare msg-ids only - angle brackets are stripped because JMAP RFC 8621
 * §4.1.2.3 stores Message-IDs without them.
 */

export interface ParentThreadingInfo {
  // JMAP RFC 8621 §4.1.2.3 specifies messageId as String[]|null, but the
  // codebase has historically typed it as string. Accept either shape.
  messageId?: string | string[];
  references?: string[];
}

export interface ReplyThreadingHeaders {
  inReplyTo: string[];
  references: string[];
}

export function stripMessageIdBrackets(id: string): string {
  return id.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
}

/** White space (Unicode line and paragraph separators included) and control characters: C0, DEL, C1. */
// eslint-disable-next-line no-control-regex
const NOT_IN_MESSAGE_ID = /[\s\x00-\x1f\x7f-\x9f]/;

/**
 * Whether a bracket-stripped id may go into In-Reply-To or References. A
 * msg-id (RFC 5322 3.6.4) holds no white space or control character, and the
 * server writes these ids into the header as they are, so an id with one is
 * dropped rather than sent. Checked where the reply headers are computed and
 * again where the message is created (lib/jmap/client.ts).
 */
export function isThreadingMessageId(id: string): boolean {
  return id !== '' && !NOT_IN_MESSAGE_ID.test(id);
}

export function computeReplyThreadingHeaders(
  parent: ParentThreadingInfo | undefined,
): ReplyThreadingHeaders | null {
  const rawId = Array.isArray(parent?.messageId) ? parent.messageId[0] : parent?.messageId;
  const strippedId = rawId ? stripMessageIdBrackets(rawId) : '';
  if (!strippedId) return null;
  const parentId = isThreadingMessageId(strippedId) ? strippedId : '';

  const ancestors = (parent?.references ?? [])
    .map(stripMessageIdBrackets)
    .filter(isThreadingMessageId);
  if (!parentId && ancestors.length === 0) return null;

  // De-dupe while preserving order; the parent's id closes the chain.
  const seen = new Set<string>();
  const references: string[] = [];
  for (const id of parentId ? [...ancestors, parentId] : ancestors) {
    if (seen.has(id)) continue;
    seen.add(id);
    references.push(id);
  }

  return { inReplyTo: parentId ? [parentId] : [], references };
}
