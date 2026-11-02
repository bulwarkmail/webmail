import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useIdentityStore, createIdentityWithHooks, updateIdentityWithHooks, deleteIdentityWithHooks, notifyIdentitySelected,
} from '../identity-store';
import { usePluginSignature } from '@/hooks/use-plugin-signature';
import { clearAllHooks, identityHooks } from '@/lib/plugin-hooks';
import type { Identity } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const identity = (overrides: Partial<Identity> = {}): Identity => ({
  id: 'id-1',
  name: 'Ann',
  email: 'ann@example.com',
  mayDelete: true,
  htmlSignature: '<b>Ann</b>',
  textSignature: 'Ann',
  ...overrides,
});

const view = (i: Identity) => ({
  id: i.id,
  name: i.name,
  email: i.email,
  replyTo: null,
  bcc: null,
  htmlSignature: i.htmlSignature ?? '',
  textSignature: i.textSignature ?? '',
});

function mockClient() {
  return {
    createIdentity: vi.fn(async () => identity({ id: 'new-1', email: 'new@example.com', name: 'New' })),
    updateIdentity: vi.fn(async () => {}),
    deleteIdentity: vi.fn(async () => {}),
  };
}

describe('identity plugin hooks', () => {
  beforeEach(() => {
    useIdentityStore.setState({ identities: [], selectedIdentityId: null });
  });
  afterEach(() => clearAllHooks());

  it('reports loaded identities, but not a reorder of the same ones', () => {
    const loaded = vi.fn();
    identityHooks.onIdentitiesLoaded.register('test', loaded);
    const a = identity();
    const b = identity({ id: 'id-2', email: 'b@example.com' });

    useIdentityStore.getState().setIdentities([a, b]);
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(loaded).toHaveBeenCalledWith([view(a), view(b)]);

    useIdentityStore.getState().setIdentities([b, a]);
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it('asks before creating and reports what the server created', async () => {
    const client = mockClient();
    const before = vi.fn(() => {
      expect(client.createIdentity).not.toHaveBeenCalled();
      return true;
    });
    const created = vi.fn();
    identityHooks.onBeforeIdentityChange.register('test', before);
    identityHooks.onIdentityCreate.register('test', created);

    const ok = await createIdentityWithHooks(client as unknown as IJMAPClient, { name: 'New', email: 'new@example.com' });

    expect(ok).toBe(true);
    expect(before).toHaveBeenCalledWith(expect.objectContaining({ change: 'create', identity: expect.objectContaining({ email: 'new@example.com' }) }));
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-1', email: 'new@example.com' }));
  });

  it('does not create when a plugin says no', async () => {
    const client = mockClient();
    const created = vi.fn();
    identityHooks.onBeforeIdentityChange.register('test', () => false);
    identityHooks.onIdentityCreate.register('test', created);

    expect(await createIdentityWithHooks(client as unknown as IJMAPClient, { name: 'x', email: 'x@example.com' })).toBe(false);
    expect(client.createIdentity).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });

  it('reports an update after the server stored it, and not when it failed', async () => {
    const client = mockClient();
    const updated = vi.fn();
    identityHooks.onIdentityUpdate.register('test', updated);

    client.updateIdentity.mockRejectedValueOnce(new Error('down'));
    await expect(updateIdentityWithHooks(client as unknown as IJMAPClient, identity(), { name: 'Anna' })).rejects.toThrow();
    expect(updated).not.toHaveBeenCalled();

    await updateIdentityWithHooks(client as unknown as IJMAPClient, identity(), { name: 'Anna' });
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-1', name: 'Anna' }));
  });

  it('stops an update when a plugin says no', async () => {
    const client = mockClient();
    const before = vi.fn(() => false);
    identityHooks.onBeforeIdentityChange.register('test', before);
    expect(await updateIdentityWithHooks(client as unknown as IJMAPClient, identity(), { name: 'Anna' })).toBe(false);
    expect(before).toHaveBeenCalledWith(expect.objectContaining({ identityId: 'id-1', change: 'update' }));
    expect(client.updateIdentity).not.toHaveBeenCalled();
  });

  it('asks before deleting and reports the deleted id', async () => {
    const client = mockClient();
    const deleted = vi.fn();
    identityHooks.onIdentityDelete.register('test', deleted);
    identityHooks.onBeforeIdentityChange.register('test', () => false);
    expect(await deleteIdentityWithHooks(client as unknown as IJMAPClient, identity())).toBe(false);
    expect(client.deleteIdentity).not.toHaveBeenCalled();

    clearAllHooks();
    identityHooks.onIdentityDelete.register('test', deleted);
    expect(await deleteIdentityWithHooks(client as unknown as IJMAPClient, identity())).toBe(true);
    expect(deleted).toHaveBeenCalledWith({ identityId: 'id-1' });
  });

  it('reports the From identity the user picked', () => {
    const selected = vi.fn();
    identityHooks.onIdentitySelect.register('test', selected);
    const b = identity({ id: 'id-2', email: 'b@example.com' });
    notifyIdentitySelected([identity(), b], 'id-2');
    expect(selected).toHaveBeenCalledWith(view(b));
  });

  it('hands the signature to plugins and uses what they return', async () => {
    identityHooks.onSignatureRender.register('test', (sig: { html: string; text: string }, ctx: { identityId: string }) => {
      expect(ctx).toEqual({ identityId: 'id-1' });
      return { html: `${sig.html}<p>Sent from Bulwark</p>`, text: `${sig.text}\nSent from Bulwark` };
    });
    const ident = identity();
    const { result } = renderHook(() => usePluginSignature(ident));

    await waitFor(() => expect(result.current.revision).toBe(1));
    expect(result.current.identity?.htmlSignature).toBe('<b>Ann</b><p>Sent from Bulwark</p>');
    expect(result.current.identity?.textSignature).toBe('Ann\nSent from Bulwark');
    expect(result.current.identity?.id).toBe('id-1');
  });

  // Plain-text mode reads textSignature, rich mode htmlSignature.
  it('makes the text signature from the HTML when a plugin changed only the HTML', async () => {
    identityHooks.onSignatureRender.register('test', (sig: { html: string; text: string }) => ({ ...sig, html: '<p>Ann &amp; Bo</p><p>Sales</p>' }));
    const ident = identity();
    const { result } = renderHook(() => usePluginSignature(ident));

    await waitFor(() => expect(result.current.revision).toBe(1));
    expect(result.current.identity?.textSignature).toBe('Ann & Bo\nSales');
  });

  it('makes the HTML signature from the text when a plugin changed only the text', async () => {
    identityHooks.onSignatureRender.register('test', (sig: { html: string; text: string }) => ({ ...sig, text: 'Ann <Sales>\n555' }));
    const ident = identity();
    const { result } = renderHook(() => usePluginSignature(ident));

    await waitFor(() => expect(result.current.revision).toBe(1));
    expect(result.current.identity?.htmlSignature).toBe('Ann &lt;Sales&gt;<br>555');
  });

  it('leaves the signature alone when no plugin listens', () => {
    const ident = identity();
    const { result } = renderHook(() => usePluginSignature(ident));
    expect(result.current.identity).toBe(ident);
  });
});
