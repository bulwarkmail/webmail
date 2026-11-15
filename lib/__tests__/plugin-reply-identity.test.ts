// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllHooks, identityHooks } from '../plugin-hooks';
import { askReplyIdentity } from '../plugin-reply-identity';
import type { Identity } from '../jmap/types';
import type { ReplyIdentityContext } from '../plugin-types';

beforeEach(() => clearAllHooks());

const personal: Identity = { id: 'id-personal', name: 'Kaan', email: 'kaan@example.org', mayDelete: false };
const gmailA: Identity = { id: 'id-a', name: 'Kaan', email: 'kaan.a@gmail.example', mayDelete: false };
const gmailB: Identity = { id: 'id-b', name: 'Kaan', email: 'kaan.b@gmail.example', mayDelete: false };
const identities = [personal, gmailA, gmailB];

const source = {
  id: 'm1',
  from: [{ name: 'Bob', email: 'bob@example.net' }],
  to: [{ name: 'List', email: 'list@example.net' }],
  cc: [],
  subject: 'Plans',
  deliveredTo: ['kaan.b@gmail.example'],
};

describe('askReplyIdentity', () => {
  it('resolves null without asking when no plugin listens', async () => {
    expect(await askReplyIdentity({ mode: 'reply', source, identities, identityId: null })).toBeNull();
  });

  it('hands plugins the message, the identities and Bulwark\'s pick, and returns theirs', async () => {
    const handler = vi.fn((ctx: ReplyIdentityContext) =>
      ctx.identities.find((i) => ctx.email.deliveredTo.includes(i.email))?.id);
    identityHooks.onSelectReplyIdentity.register('p', handler);

    expect(await askReplyIdentity({ mode: 'quick-reply', source, identities, identityId: 'id-personal' })).toBe('id-b');
    expect(handler).toHaveBeenCalledWith({
      mode: 'quick-reply',
      email: {
        id: 'm1',
        from: [{ name: 'Bob', email: 'bob@example.net' }],
        to: [{ name: 'List', email: 'list@example.net' }],
        cc: [],
        bcc: [],
        subject: 'Plans',
        deliveredTo: ['kaan.b@gmail.example'],
      },
      identities: [
        { id: 'id-personal', name: 'Kaan', email: 'kaan@example.org' },
        { id: 'id-a', name: 'Kaan', email: 'kaan.a@gmail.example' },
        { id: 'id-b', name: 'Kaan', email: 'kaan.b@gmail.example' },
      ],
      identityId: 'id-personal',
    });
  });

  it('ignores an id that is none of the identities', async () => {
    identityHooks.onSelectReplyIdentity.register('p', () => 'id-elsewhere');
    expect(await askReplyIdentity({ mode: 'reply', source, identities, identityId: null })).toBeNull();
  });

  it('keeps Bulwark\'s pick when the plugin has no answer or confirms it', async () => {
    identityHooks.onSelectReplyIdentity.register('p', () => undefined);
    identityHooks.onSelectReplyIdentity.register('q', () => 'id-a');
    expect(await askReplyIdentity({ mode: 'reply', source, identities, identityId: 'id-a' })).toBeNull();
  });

  it('passes one plugin\'s pick on to the next', async () => {
    identityHooks.onSelectReplyIdentity.register('p', () => 'id-a', 1);
    const second = vi.fn((ctx: ReplyIdentityContext) => (ctx.identityId === 'id-a' ? undefined : 'id-b'));
    identityHooks.onSelectReplyIdentity.register('q', second, 2);
    expect(await askReplyIdentity({ mode: 'reply-all', source, identities, identityId: null })).toBe('id-a');
    expect(second.mock.calls[0][0].identityId).toBe('id-a');
  });

  it('takes the context back with a changed identityId too', async () => {
    identityHooks.onSelectReplyIdentity.register('p', (ctx: ReplyIdentityContext) => ({ ...ctx, identityId: 'id-a' }));
    expect(await askReplyIdentity({ mode: 'forward', source, identities, identityId: null })).toBe('id-a');
  });
});
