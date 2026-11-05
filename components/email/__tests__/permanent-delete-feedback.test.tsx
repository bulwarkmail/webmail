import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { clearAllStores } from '@/lib/account-state-manager';
import { JMAPClient } from '@/lib/jmap/client';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { MvListToolbar } from '../mv-list-toolbar';
import { EmailList } from '../email-list';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
const initial = useEmailStore.getState();
let calls: string[][];
let result: object | Promise<object>;
beforeEach(() => {
  clearAllHooks(); vi.clearAllMocks(); calls = []; result = { destroyed: ['ok', 'no'] };
  const client = JMAPClient.withBearer('https://delete.example.invalid', 'synthetic', 'test@example.invalid');
  Object.assign(client, { apiUrl: 'https://delete.example.invalid/jmap', accountId: 'c' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://delete.example.invalid/jmap');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic');
    const [[method, args]] = JSON.parse(String(init.body)).methodCalls;
    if (method === 'Mailbox/get') return new Response(JSON.stringify({ methodResponses: [[method, { list: [] }, '0']] }));
    expect(method).toBe('Email/set'); expect(args.accountId).toBe('c'); calls.push(args.destroy);
    return new Response(JSON.stringify({ methodResponses: [['Email/set', await result, '0']] }));
  }));
  useAuthStore.setState({ activeAccountId: 'test', client, getClientForAccount: () => client } as never);
  useSettingsStore.setState({ confirmBulkDelete: false, permanentlyDeleteJunk: false, deleteAction: 'trash', interfaceLayout: 'default' });
  useEmailStore.setState(initial, true);
  const emails = ['ok', 'no'].map(id => ({ id, threadId: 't-' + id, blobId: 'b-' + id,
    mailboxIds: { trash: true }, keywords: {}, subject: id, receivedAt: '2026-10-01T00:00:00Z',
    from: [{ email: 'test@example.invalid' }], size: 1, hasAttachment: false } as Email));
  useEmailStore.setState({ emails, mailboxes: [{ id: 'trash', name: 'Trash', role: 'trash', accountId: 'c',
    totalEmails: 2, unreadEmails: 2, totalThreads: 2, unreadThreads: 2,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true } } as Mailbox],
    selectedMailbox: 'trash', selectedEmailKeys: new Set(['ok', 'no']), selectedEmail: emails[1], totalEmails: 2 });
});
afterEach(() => { clearAllHooks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function clickDelete(surface: string) {
  if (surface === 'context') {
    // Give jsdom's real virtualized rows a layout so the actual row menu is reachable.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.hasAttribute('data-index') ? 60 : 300;
      return { x: 0, y: 0, width: 600, height, top: 0, left: 0, right: 600, bottom: height, toJSON: () => ({}) } as DOMRect;
    });
  }
  render(surface === 'mountain' ? <MvListToolbar loadedCount={2} onRefresh={() => {}} />
    : <EmailList emails={useEmailStore.getState().emails} />);
  if (surface === 'context') {
    fireEvent.contextMenu(await screen.findByText('ok')); fireEvent.click(await screen.findByTestId('ctx-delete'));
  } else {
    fireEvent.click(surface === 'mountain' ? screen.getByLabelText('delete') : screen.getByTitle('batch_actions.delete'));
  }
  // A permanent delete asks first, from every place it is offered.
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /delete_forever$/ }));
}

for (const surface of ['mountain', 'default', 'context']) describe(surface + ' permanent bulk-delete feedback', () => {
  it.each(['partial', 'empty', 'success'])('reports %s using the real action and serialized JMAP request', async kind => {
    result = kind === 'partial' ? { destroyed: ['ok'], notDestroyed: { no: { type: 'forbidden', description: 'Synthetic refusal' } } }
      : kind === 'empty' ? {} : { destroyed: ['ok', 'no'] };
    await clickDelete(surface);
    await waitFor(() => expect(toast[kind === 'success' ? 'success' : 'error']).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([['ok', 'no']]);
    expect(toast[kind === 'success' ? 'error' : 'success']).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(kind === 'success' ? [] : kind === 'partial' ? ['no'] : ['ok', 'no']);
    if (kind === 'partial') expect(toast.error).toHaveBeenCalledWith('error_deleting', expect.stringContaining('Synthetic refusal'));
  });

  it('keeps a plugin veto silent without sending a delete', async () => {
    const before = vi.fn(() => false); emailHooks.onBeforeEmailDelete.register('veto', before);
    await clickDelete(surface); await waitFor(() => expect(before).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([]); expect(toast.success).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(2);
  });
});


for (const surface of ['mountain', 'default', 'context']) describe(surface + ' pending permanent-delete failure feedback', () => {
  it.each(['same-view', 'navigation', 'reset'])('does not report success after rejection in %s', async kind => {
    let reject!: (error: Error) => void;
    result = new Promise<object>((_resolve, fail) => { reject = fail; });
    const batchDelete = vi.fn(initial.batchDelete);
    useEmailStore.setState({ batchDelete });
    await clickDelete(surface); await waitFor(() => expect(calls).toHaveLength(1));
    const completion = batchDelete.mock.results[0].value;
    let expected = useEmailStore.getState();
    await act(async () => {
      if (kind === 'reset') clearAllStores();
      if (kind === 'navigation') {
        useEmailStore.getState().selectMailbox('new-folder');
        const fresh = { ...initial.emails[0], id: 'fresh', threadId: 'fresh', keywords: {}, mailboxIds: { 'new-folder': true },
          size: 1, hasAttachment: false, receivedAt: '2026-10-01T00:00:00Z' } as Email;
        useEmailStore.setState({ emails: [fresh], selectedEmailKeys: new Set(['fresh']), selectedEmail: fresh,
          isLoading: true, error: null });
      }
      expected = useEmailStore.getState();
      reject(new Error('Old delete failed'));
      expect(await completion).toBe(false);
    });
    expect(toast.success).not.toHaveBeenCalled();
    if (kind === 'same-view') {
      expect(useEmailStore.getState().error).toContain('Old delete failed');
      expect(toast.error).toHaveBeenCalledWith('error_deleting', expect.stringContaining('Old delete failed'));
    } else {
      const current = useEmailStore.getState();
      expect(current.emails).toBe(expected.emails); expect(current.selectedEmailKeys).toBe(expected.selectedEmailKeys);
      expect(current.selectedEmail).toBe(expected.selectedEmail); expect(current.selectedMailbox).toBe(expected.selectedMailbox);
      expect(current.isLoading).toBe(expected.isLoading); expect(current.error).toBe(expected.error);
      expect(toast.error).not.toHaveBeenCalled();
    }
  });
});
