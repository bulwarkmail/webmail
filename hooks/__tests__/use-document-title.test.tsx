import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Acme Mail' }) }));

import { useDocumentTitle } from '@/hooks/use-document-title';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';
import { PaneIdContext, ProTabFocusContext } from '@/hooks/use-pane-context';

const account = (id: string, email: string) => ({ id, email }) as AccountEntry;

/**
 * What Next does on a client-side navigation: it renders the root layout's
 * metadata <title> again, after the new surface has mounted.
 */
function rerenderMetadataTitle(title = 'Acme Mail'): void {
  document.head.querySelectorAll('title').forEach((el) => el.remove());
  const el = document.createElement('title');
  el.textContent = title;
  document.head.appendChild(el);
}

/** A surface in a Pro shell tab, which stays mounted while hidden. */
function TitleProbe({ context }: { context: string }) {
  useDocumentTitle(context);
  return null;
}
function ProTab({ context, focused }: { context: string; focused: boolean }) {
  return (
    <PaneIdContext.Provider value="main">
      <ProTabFocusContext.Provider value={focused}>
        <TitleProbe context={context} />
      </ProTabFocusContext.Provider>
    </PaneIdContext.Provider>
  );
}

/** Drains MutationObserver callbacks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = '';
    useAccountStore.setState({
      accounts: [account('a', 'jane@example.com'), account('b', 'joe@example.com')],
      activeAccountId: 'a',
    });
  });

  it('names the active account between the context and the app', () => {
    renderHook(() => useDocumentTitle('Calendar'));
    expect(document.title).toBe('Calendar - jane@example.com - Acme Mail');
  });

  it('follows an account switch', () => {
    renderHook(() => useDocumentTitle('Calendar'));
    act(() => useAccountStore.setState({ activeAccountId: 'b' }));
    expect(document.title).toBe('Calendar - joe@example.com - Acme Mail');
  });

  it('shows the account and the app when the surface adds no context', () => {
    renderHook(() => useDocumentTitle());
    expect(document.title).toBe('jane@example.com - Acme Mail');
  });

  it('shows the context and the app when no account is in view', () => {
    useAccountStore.setState({ accounts: [], activeAccountId: null });
    renderHook(() => useDocumentTitle('Settings'));
    expect(document.title).toBe('Settings - Acme Mail');
  });

  it('writes a title with runs of whitespace once instead of over and over', async () => {
    // The browser reads the title back with its whitespace collapsed, so it
    // never equals what was written. Count the writes, and stop a runaway
    // loop instead of hanging the test.
    const native = Object.getOwnPropertyDescriptor(Document.prototype, 'title')!;
    let writes = 0;
    Object.defineProperty(document, 'title', {
      configurable: true,
      get: () => native.get!.call(document),
      set: (value: string) => {
        writes += 1;
        if (writes > 20) throw new Error('the title is written over and over');
        native.set!.call(document, value);
      },
    });
    try {
      renderHook(() => useDocumentTitle('[Spam]  Offer\tinside '));
      expect(document.title).toBe('[Spam] Offer inside - jane@example.com - Acme Mail');
      expect(writes).toBe(1);
      // Next renders its metadata title again: the title is put back once.
      rerenderMetadataTitle();
      await settle();
      expect(document.title).toBe('[Spam] Offer inside - jane@example.com - Acme Mail');
      expect(writes).toBe(2);
    } finally {
      delete (document as { title?: string }).title;
    }
  });

  it('puts its title back when the metadata title is rendered again', async () => {
    renderHook(() => useDocumentTitle('Settings'));
    rerenderMetadataTitle();
    await waitFor(() => expect(document.title).toBe('Settings - jane@example.com - Acme Mail'));
  });

  it('leaves the title to the surface that set it last', async () => {
    renderHook(() => useDocumentTitle('Inbox'));
    renderHook(() => useDocumentTitle('Settings'));
    rerenderMetadataTitle();
    await waitFor(() => expect(document.title).toBe('Settings - jane@example.com - Acme Mail'));
    await settle();
    expect(document.title).toBe('Settings - jane@example.com - Acme Mail');
  });

  it('in the Pro shell, leaves the title to the focused tab', () => {
    const mail = render(<ProTab context="Inbox" focused />);
    const settings = render(<ProTab context="Settings" focused={false} />);
    expect(document.title).toBe('Inbox - jane@example.com - Acme Mail');

    mail.rerender(<ProTab context="Inbox" focused={false} />);
    settings.rerender(<ProTab context="Settings" focused />);
    expect(document.title).toBe('Settings - jane@example.com - Acme Mail');

    // New mail in the hidden Mail tab must not take the title back.
    mail.rerender(<ProTab context="Inbox (5)" focused={false} />);
    expect(document.title).toBe('Settings - jane@example.com - Acme Mail');
  });

  it('stops re-applying once unmounted', async () => {
    const { unmount } = renderHook(() => useDocumentTitle('Settings'));
    unmount();
    rerenderMetadataTitle('Sign in');
    await settle();
    expect(document.title).toBe('Sign in');
  });
});
