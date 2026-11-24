/**
 * onSenderResolve (#633): a plugin shows another sender than From, in the
 * message list and the reader, for display only.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Email } from '../../jmap/types';
import { avatarHooks } from '../../plugin-hooks';
import { hookPermission } from '../permissions';
import { normalizeSender, resetSenderResolve } from '../sender-resolve';
import { usePluginSender } from '@/hooks/use-plugin-sender';

const aliasMail = {
  id: 'm1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: {},
  receivedAt: '2026-11-20T10:00:00Z',
  from: [{ name: 'Alice - alice at example.com', email: 'alice_at_example_com_ab3xk@passmail.com' }],
} as unknown as Email;

afterEach(() => {
  avatarHooks.onSenderResolve.clear();
  resetSenderResolve();
});

describe('normalizeSender', () => {
  it('keeps a name and an address', () => {
    expect(normalizeSender({ name: ' Alice ', email: 'alice@example.com' })).toEqual({ name: 'Alice', email: 'alice@example.com' });
  });

  it.each([
    ['no answer', undefined],
    ['a string', 'alice@example.com'],
    ['no address', { name: 'Alice' }],
    ['no address at all', { name: 'Alice', email: 'alice' }],
    ['two addresses', { name: 'A', email: 'a@x.org, b@y.org' }],
    ['an address in brackets', { name: 'A', email: '<a@x.org>' }],
  ])('drops %s', (_name, value) => {
    expect(normalizeSender(value)).toBeNull();
  });

  it('strips direction marks that could make one address read as another', () => {
    expect(normalizeSender({ name: 'Bank\u202e', email: 'moc.knab@evil.org' })).toEqual({ name: 'Bank', email: 'moc.knab@evil.org' });
  });
});

describe('onSenderResolve', () => {
  it('needs email:render-takeover, as changing what a message shows does', () => {
    expect(hookPermission('onSenderResolve')).toBe('email:render-takeover');
  });

  it("shows the plugin's sender for the message", async () => {
    avatarHooks.onSenderResolve.register('simplelogin', (_current: unknown, ctx: { email: { from: { email: string }[] } }) =>
      ctx.email.from[0].email.endsWith('@passmail.com') ? { name: 'Alice', email: 'alice@example.com' } : undefined);
    const { result } = renderHook(() => usePluginSender(aliasMail));
    await waitFor(() => expect(result.current).toEqual({ name: 'Alice', email: 'alice@example.com' }));
    // Display only: the message keeps its From.
    expect(aliasMail.from?.[0].email).toBe('alice_at_example_com_ab3xk@passmail.com');
  });

  it('shows From when no plugin answers', async () => {
    let asked = 0;
    avatarHooks.onSenderResolve.register('quiet', () => { asked++; return undefined; });
    const { result } = renderHook(() => usePluginSender(aliasMail));
    await waitFor(() => expect(asked).toBe(1));
    expect(result.current).toBeNull();
  });

  it('asks again when a plugin starts after the list was drawn', async () => {
    const { result } = renderHook(() => usePluginSender(aliasMail));
    expect(result.current).toBeNull();
    act(() => {
      avatarHooks.onSenderResolve.register('late', () => ({ name: 'Alice', email: 'alice@example.com' }));
    });
    await waitFor(() => expect(result.current?.email).toBe('alice@example.com'));
  });
});
