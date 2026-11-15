// onSelectReplyIdentity: plugins pick the From identity of a reply, reply-all,
// forward or quick reply (#1694). The host makes its own pick first and hands
// it in; a plugin's answer counts only when it is the id of one of the
// identities offered. The full composer and the quick reply ask this, and
// each lets a From the user picked by hand win.

import type { Identity } from './jmap/types';
import type { ReplyIdentityContext } from './plugin-types';
import { identityHooks } from './plugin-hooks';

type Address = { name?: string | null; email?: string | null };

export interface ReplyIdentitySource {
  id?: string;
  from?: Address[] | null;
  to?: Address[] | null;
  cc?: Address[] | null;
  bcc?: Address[] | null;
  subject?: string | null;
  deliveredTo?: string[];
}

/** A plugin that doesn't answer within this keeps the host's pick. */
const ANSWER_TIMEOUT_MS = 5000;

const addresses = (list: Address[] | null | undefined) => (list ?? [])
  .filter((a): a is Address & { email: string } => typeof a?.email === 'string' && a.email.length > 0)
  .map((a) => ({ name: a.name || '', email: a.email }));

export function hasReplyIdentityPlugins(): boolean {
  return identityHooks.onSelectReplyIdentity.size > 0;
}

/**
 * Ask the plugins which identity to send from. Resolves to the identity id
 * a plugin picked, or null when none did (or none listens, or the answer
 * isn't one of `identities`).
 */
export async function askReplyIdentity(input: {
  mode: ReplyIdentityContext['mode'];
  source: ReplyIdentitySource;
  identities: Identity[];
  identityId: string | null;
}): Promise<string | null> {
  if (!hasReplyIdentityPlugins() || input.identities.length === 0) return null;
  const offered = new Set(input.identities.map((i) => i.id));
  const context: ReplyIdentityContext = {
    mode: input.mode,
    email: {
      ...(input.source.id ? { id: input.source.id } : {}),
      from: addresses(input.source.from),
      to: addresses(input.source.to),
      cc: addresses(input.source.cc),
      bcc: addresses(input.source.bcc),
      subject: input.source.subject || '',
      deliveredTo: [...(input.source.deliveredTo ?? [])],
    },
    identities: input.identities.map((i) => ({ id: i.id, name: i.name || '', email: i.email })),
    identityId: input.identityId,
  };
  const outcome = await identityHooks.onSelectReplyIdentity.interceptWithValue(
    context,
    (result, current) => {
      const id = typeof result === 'string'
        ? result
        : result && typeof result === 'object' && typeof (result as { identityId?: unknown }).identityId === 'string'
          ? (result as { identityId: string }).identityId
          : undefined;
      return id !== undefined && offered.has(id) ? { ...current, identityId: id } : undefined;
    },
    { timeoutMs: ANSWER_TIMEOUT_MS },
  );
  if (!outcome.allowed) return null;
  const picked = outcome.value.identityId;
  return picked !== null && picked !== input.identityId ? picked : null;
}
