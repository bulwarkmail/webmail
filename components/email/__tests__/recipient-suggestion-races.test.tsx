import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { ContactCard } from '@/lib/jmap/types';
import type { RecipientSuggestion } from '@/lib/plugin-types';

// Keep the recipient controls, contact store, hook bus and Sent filtering real.
// Only unrelated surfaces and account/settings scaffolding are mocked.

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ onChange }: { onChange?: (html: string) => void }) => (
    React.createElement('div', { 'data-testid': 'rich-text-editor', onClick: () => onChange?.('') })
  ),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ ref: { current: null } }),
}));
const { clients } = vi.hoisted(() => ({ clients: new Map<string, IJMAPClient>() }));


vi.mock('@/stores/auth-store', () => {
  const state = {
    client: null,
    identities: [],
    primaryIdentity: null,
    isAuthenticated: false,
    isDemoMode: false,
    activeAccountId: null,
    connectionLost: false,
    getClientForAccount: (id: string) => clients.get(id),
    getAllConnectedClients: () => new Map(),
    syncIdentities: () => {},
    refreshIdentities: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/identity-store')>();
  const state = { identities: [], defaultIdentityId: null };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { ...actual, useIdentityStore: hook };
});

vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: (id: string) => state.accounts.find((a: { id: string }) => a.id === id) };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAccountStore: hook };
});

vi.mock('@/stores/email-store', () => {
  const state = {
    draftSaveEnabled: false,
    sendRawEmail: async () => { throw new Error('Unexpected send in recipient test'); },
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

vi.mock('@/stores/settings-store', () => {
  const state = {
    proInterface: false,
    timeFormat: '24h',
    plainTextMode: false,
    subAddressDelimiter: '+',
    autoSelectReplyIdentity: true,
    attachmentReminderEnabled: false,
    attachmentReminderKeywords: [],
    sendDelaySeconds: 0,
    signaturePosition: 'above_quote',
    signatureSeparatorEnabled: false,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useSettingsStore: hook };
});

vi.mock('@/stores/template-store', () => {
  const state = { templates: [], addTemplate: async () => {} };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useTemplateStore: hook };
});



vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: () => {}, success: () => {} },
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/reply-identity', () => ({
  resolveReplyFrom: () => null,
  findComposeIdentityId: () => null,
  findReplyIdentityId: () => null,
  findDraftIdentityId: () => null,
}));
vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/signature-utils', () => ({
  appendPlainTextSignature: (body: string) => body,
  getPlainTextSignature: () => '',
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: Object.assign(() => {}, { log: () => {}, error: () => {}, warn: () => {} }) }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

import { useContactStore } from '@/stores/contact-store';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useAccountStore } from '@/stores/account-store';
import { contactHooks } from '@/lib/plugin-hooks';
import { JMAPClient } from '@/lib/jmap/client';

type JMAPMethodCall = [string, Record<string, unknown>, string];
type JMAPResponse = { methodResponses: [string, Record<string, unknown>, string][] };
type Field = 'to' | 'cc' | 'bcc';
type Suggestion = { name: string; email: string };
const EMPTY_DATA = {
  to: '', cc: '', bcc: '', subject: '', body: '', showCc: true, showBcc: true,
  selectedIdentityId: null, subAddressTag: '', mode: 'compose' as const, draftId: null,
};
const suggestion = (name: string, email = `${name.toLowerCase()}@example.test`): Suggestion => ({ name, email });
const alpha = suggestion('Alpha');
const bravo = suggestion('Bravo');
const seeded = suggestion('Seeded');
const card = (r: Suggestion): ContactCard => ({
  id: r.email, kind: 'individual', name: { full: r.name },
  emails: { e0: { address: r.email } }, addressBookIds: {},
} as ContactCard);
const input = (field: Field = 'to') => screen.getAllByRole('combobox')
  .filter(e => e.tagName === 'INPUT')[['to', 'cc', 'bcc'].indexOf(field)] as HTMLInputElement;
function type(value: string, field: Field = 'to') {
  act(() => input(field).focus());
  fireEvent.change(input(field), { target: { value } });
}
const advance = async (ms = 200) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const rows = () => screen.queryAllByRole('option').filter(e => e.tagName === 'BUTTON').map(e => e.textContent).join('|');
const expectClosed = () => expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
async function resolve<T>(gate: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => { gate.resolve(value); await gate.promise; });
}
function pluginService() {
  const calls: { query: string; initial: RecipientSuggestion[]; gate: ReturnType<typeof deferred<RecipientSuggestion[]>> }[] = [];
  contactHooks.onProvideRecipientSuggestions.register('synthetic-recipient-test', (initial: RecipientSuggestion[], { query }: { query: string }) => {
    const gate = deferred<RecipientSuggestion[]>();
    calls.push({ query, initial, gate });
    return gate.promise;
  });
  return calls;
}
function mockClient(id = 'A') {
  const requests: { methods: JMAPMethodCall[]; gate: ReturnType<typeof deferred<JMAPResponse>> }[] = [];
  const self = {
    accountId: `server-${id}`,
    request: vi.fn((methods: JMAPMethodCall[]) => {
      const gate = deferred<JMAPResponse>(); requests.push({ methods, gate }); return gate.promise;
    }),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
    getIdentities: vi.fn(async () => [{ id: 'id', name: `Sender ${id}`, email: `sender-${id}@example.test` }]),
    searchSentRecipients: vi.fn((q: string, mailbox: string) =>
      JMAPClient.prototype.searchSentRecipients.call(self as unknown as JMAPClient, q, mailbox)),
  };
  clients.set(id, self as unknown as IJMAPClient);
  return { self, requests };
}
function enableSent() {
  const c = mockClient();
  useAuthStore.setState({ client: c.self, activeAccountId: 'A' } as never);
  useContactStore.setState({ sentMailboxId: 'sent-A' });
  return c;
}
const serverResponse = (recipients: Suggestion[]): JMAPResponse => ({
  methodResponses: [
    ['Email/query', { ids: ['synthetic-message'] }, '0'],
    ['Email/get', { list: [{ to: recipients, cc: [suggestion('Unrelated')] }] }, '1'],
  ],
} as JMAPResponse);
const startServer = () => fireEvent.mouseDown(screen.getByRole('button', { name: 'autocomplete_search_server' }));
const seededData = { ...EMPTY_DATA, to: 'Seeded <seeded@example.test>' };

beforeEach(() => {
  vi.useFakeTimers();
  contactHooks.onProvideRecipientSuggestions.clear();
  clients.clear();
  useAuthStore.setState({ client: null, activeAccountId: null } as never);
  useIdentityStore.setState({ identities: [], defaultIdentityId: null } as never);
  useAccountStore.setState({ accounts: [] } as never);
  useContactStore.setState({
    contacts: [card(alpha), card(bravo), card(seeded)], directoryPrincipals: [], recentRecipients: [],
    sentMailboxId: null, accountClients: null,
  } as never);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in recipient test'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  contactHooks.onProvideRecipientSuggestions.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recipient suggestion request ownership', () => {
  it('keeps B results when plugin A completes after B', async () => {
    const calls = pluginService(); render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance(); type('Bravo'); await advance();
    expect(calls.map(c => c.query)).toEqual(['Alpha', 'Bravo']);
    await resolve(calls[1].gate, calls[1].initial);
    expect(rows()).toContain('Bravo');
    await resolve(calls[0].gate, calls[0].initial);
    expect(input()).toHaveValue('Bravo');
    expect(rows()).toContain('Bravo'); expect(rows()).not.toContain('Alpha');
  });

  it('invalidates A immediately when B is typed, before B debounce fires', async () => {
    const calls = pluginService(); render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance(); type('Bravo');
    await resolve(calls[0].gate, calls[0].initial); expectClosed();
    await advance(); await resolve(calls[1].gate, calls[1].initial); expect(rows()).toContain('Bravo');
  });

  it('distinguishes A → B → A requests even when query text matches again', async () => {
    const calls = pluginService(); render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance(); type('Bravo'); await advance(); type('Alpha'); await advance();
    await resolve(calls[2].gate, [suggestion('Alpha current')]);
    await resolve(calls[0].gate, [suggestion('Alpha old')]);
    await resolve(calls[1].gate, calls[1].initial);
    expect(rows()).toContain('Alpha current'); expect(rows()).not.toContain('Alpha old'); expect(rows()).not.toContain('Bravo');
  });

  it.each(['clear', 'select', 'Escape', 'Enter', 'Tab', 'blur', 'paste'] as const)(
    '%s survives an older plugin completion and preserves chips', async action => {
      const calls = pluginService(); render(<EmailComposer initialData={seededData} />);
      type('Alpha'); await advance();
      if (action === 'clear') type('');
      else if (action === 'select' || action === 'Escape') {
        type('Bravo'); await advance(); await resolve(calls[1].gate, calls[1].initial);
        if (action === 'select') fireEvent.mouseDown(screen.getByRole('option'));
        else fireEvent.keyDown(input(), { key: 'Escape' });
      } else if (action === 'paste') {
        type(''); type('alpha@example.test'); await advance();
        fireEvent.paste(input(), { clipboardData: { getData: () => 'bravo@example.test; seeded2@example.test' } });
        // Pasting keeps preexisting input. Clear it as a normal follow-up edit.
        type('');
      } else {
        type('alpha@example.test'); await advance();
        if (action === 'blur') act(() => (screen.getByPlaceholderText('subject_placeholder') as HTMLInputElement).focus());
        else fireEvent.keyDown(input(), { key: action });
      }
      expectClosed();
      for (const call of calls) await resolve(call.gate, call.initial);
      await advance();
      expectClosed(); expect(screen.getByTitle('Seeded <seeded@example.test>')).toBeInTheDocument();
      if (action === 'select') expect(screen.getByTitle('Bravo <bravo@example.test>')).toBeInTheDocument();
      if (['Enter', 'Tab', 'blur'].includes(action)) expect(screen.getByText('alpha@example.test')).toBeInTheDocument();
      if (action === 'paste') expect(screen.getByText('bravo@example.test')).toBeInTheDocument();
    },
  );

  it('invalidates a pending lookup when a paste changes the remaining query lifecycle', async () => {
    const calls = pluginService(); render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance();
    fireEvent.paste(input(), { clipboardData: { getData: () => 'bravo@example.test; second@example.test' } });
    expect(input()).toHaveValue('Alpha');
    await resolve(calls[0].gate, [suggestion('Alpha old')]); expectClosed();
    await advance(); expect(calls).toHaveLength(2);
    await resolve(calls[1].gate, [suggestion('Alpha current')]);
    expect(rows()).toContain('Alpha current'); expect(rows()).not.toContain('Alpha old');
    expect(screen.getByText('bravo@example.test')).toBeInTheDocument();
  });

  it('dismisses a server-only popup on Escape while an older plugin lookup is pending', async () => {
    enableSent(); const calls = pluginService(); render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance(); type('NoMatch'); await advance();
    await resolve(calls[1].gate, []); expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    fireEvent.keyDown(input(), { key: 'Escape' }); expectClosed();
    await resolve(calls[0].gate, calls[0].initial); expectClosed();
  });

  it.each(['cc', 'bcc'] as const)('transfers lookup ownership from To to %s through focus and typing', async field => {
    const calls = pluginService(); render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance(); type('Bravo', field); await advance();
    await resolve(calls[1].gate, calls[1].initial); await resolve(calls[0].gate, calls[0].initial);
    expect(screen.getByRole('listbox')).toHaveAttribute('id', `autocomplete-${field}`);
    expect(rows()).toContain('Bravo'); expect(rows()).not.toContain('Alpha');
    fireEvent.keyDown(input(field), { key: 'Enter' });
    expect(screen.getByTitle('Bravo <bravo@example.test>')).toBeInTheDocument(); expectClosed();
  });

  it.each([false, true])('isolates reopened composers and cancels pre-debounce work (StrictMode=%s)', async strict => {
    const calls = pluginService();
    const composer = (key: string) => strict
      ? <React.StrictMode><EmailComposer key={key} initialData={seededData} /></React.StrictMode>
      : <EmailComposer key={key} initialData={seededData} />;
    let view = render(composer('first')); type('Alpha'); view.unmount(); await advance(); expect(calls).toHaveLength(0);
    view = render(composer('second')); type('Alpha'); await advance(); view.unmount();
    render(composer('third')); type('Bravo'); await advance(); await resolve(calls[1].gate, calls[1].initial);
    await resolve(calls[0].gate, calls[0].initial); expect(rows()).toContain('Bravo'); expect(rows()).not.toContain('Alpha');
    expect(screen.getByTitle('Seeded <seeded@example.test>')).toBeInTheDocument();
  });

  it('preserves threshold, 200 ms debounce, superseded timers and current plugin completion', async () => {
    const calls = pluginService(); render(<EmailComposer initialData={EMPTY_DATA} />);
    type(' '); await advance(); expect(calls).toHaveLength(0);
    type('Alpha'); await advance(100); type('B'); await advance(199); expect(calls).toHaveLength(0);
    await advance(1); expect(calls.map(c => c.query)).toEqual(['B']);
    await resolve(calls[0].gate, calls[0].initial); expect(rows()).toContain('Bravo');
    fireEvent.keyDown(input(), { key: 'Tab' }); expectClosed(); expect(screen.getByTitle('Bravo <bravo@example.test>')).toBeInTheDocument();
  });

  it('retains previous rows during debounce without default-selecting another query', async () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance(); expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    type('Bravo'); expect(rows()).toContain('Alpha'); expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'false');
    await advance(); expect(rows()).toContain('Bravo'); expect(rows()).not.toContain('Alpha');
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps real hook timeout fallback from an obsolete lookup out of current results', async () => {
    const calls = pluginService(); const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance(); type('Bravo'); await advance(); await resolve(calls[1].gate, calls[1].initial);
    await advance(5000); expect(rows()).toContain('Bravo'); expect(rows()).not.toContain('Alpha');
    expect(error).toHaveBeenCalled(); error.mockRestore();
  });

  it('does not append Sent A to completed local B and releases the guard for valid B retry', async () => {
    const c = enableSent(); render(<EmailComposer initialData={seededData} />);
    type('Alpha'); await advance(); startServer();
    type('Bravo'); await advance();
    const pending = screen.getByRole('button', { name: 'autocomplete_searching' }); expect(pending).toBeDisabled();
    fireEvent.mouseDown(pending); expect(c.requests).toHaveLength(1);
    await resolve(c.requests[0].gate, serverResponse([alpha]));
    expect(rows()).toContain('Bravo'); expect(rows()).not.toContain('Alpha');
    startServer(); expect(c.self.searchSentRecipients).toHaveBeenLastCalledWith('Bravo', 'sent-A');
    await resolve(c.requests[1].gate, serverResponse([bravo, suggestion('Bravo remote')]));
    expect(rows()).toContain('Bravo remote'); expect(screen.getByTitle('Seeded <seeded@example.test>')).toBeInTheDocument();
  });

  it('does not reuse Sent A after A → B → A', async () => {
    const c = enableSent(); render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance(); startServer(); type('Bravo'); await advance(); type('Alpha'); await advance();
    await resolve(c.requests[0].gate, serverResponse([suggestion('Alpha old remote')]));
    expect(rows()).toContain('Alpha'); expect(rows()).not.toContain('old remote');
    startServer(); await resolve(c.requests[1].gate, serverResponse([suggestion('Alpha current remote')])); expect(rows()).toContain('Alpha current remote');
  });

  it.each(['cc', 'bcc'] as const)('does not append To Sent results to %s after a field change', async field => {
    const c = enableSent(); render(<EmailComposer initialData={EMPTY_DATA} />);
    type('Alpha'); await advance(); startServer(); type('Bravo', field); await advance();
    await resolve(c.requests[0].gate, serverResponse([alpha]));
    expect(screen.getByRole('listbox')).toHaveAttribute('id', `autocomplete-${field}`);
    expect(rows()).toContain('Bravo'); expect(rows()).not.toContain('Alpha');
    startServer(); await resolve(c.requests[1].gate, serverResponse([suggestion('Bravo remote')])); expect(rows()).toContain('Bravo remote');
  });

  it.each(['clear', 'select', 'Escape'] as const)('does not reopen after %s followed by Sent completion', async action => {
    const c = enableSent(); render(<EmailComposer initialData={seededData} />);
    type('Alpha'); await advance(); startServer();
    if (action === 'clear') type('');
    else if (action === 'select') fireEvent.mouseDown(screen.getByRole('option'));
    else fireEvent.keyDown(input(), { key: 'Escape' });
    await resolve(c.requests[0].gate, serverResponse([alpha])); expectClosed();
    expect(screen.getByTitle('Seeded <seeded@example.test>')).toBeInTheDocument();
  });

  it.each([false, true])('keeps Sent completion out of a reopened composer (StrictMode=%s)', async strict => {
    const c = enableSent();
    const composer = (key: string) => <React.Fragment>{strict
      ? <React.StrictMode><EmailComposer key={key} initialData={EMPTY_DATA} /></React.StrictMode>
      : <EmailComposer key={key} initialData={EMPTY_DATA} />}</React.Fragment>;
    const view = render(composer('first')); type('Alpha'); await advance(); startServer(); view.unmount();
    render(composer('second')); type('Bravo'); await advance(); startServer();
    await resolve(c.requests[0].gate, serverResponse([alpha]));
    expect(screen.getByRole('button', { name: 'autocomplete_searching' })).toBeDisabled();
    expect(rows()).toContain('Bravo'); expect(rows()).not.toContain('Alpha');
    await resolve(c.requests[1].gate, serverResponse([suggestion('Bravo remote')])); expect(rows()).toContain('Bravo remote');
  });

  it.each([false, true])('preserves Sent filtering/deduplication and retries after service rejection (obsolete=%s)', async obsolete => {
    const c = enableSent(); const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<EmailComposer initialData={EMPTY_DATA} />); type('Alpha'); await advance(); startServer();
    const methods = c.requests[0].methods;
    expect(methods[0][1]).toMatchObject({ accountId: 'server-A', filter: { conditions: [{ inMailbox: 'sent-A' }, { operator: 'OR', conditions: [{ to: 'Alpha' }, { cc: 'Alpha' }] }] } });
    expect(methods[1][1].properties).toEqual(['to', 'cc']);
    if (obsolete) { type('Bravo'); await advance(); }
    // The real JMAP method and contact-store action absorb service failures.
    await act(async () => { c.requests[0].gate.reject(new Error('synthetic offline')); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'autocomplete_search_server' })).toBeEnabled();
    const current = obsolete ? bravo : alpha;
    expect(rows()).toContain(current.name); startServer(); expect(c.requests).toHaveLength(2);
    await resolve(c.requests[1].gate, serverResponse([current, current, suggestion(`${current.name} remote`)]));
    expect(screen.getAllByRole('option')).toHaveLength(2); expect(rows()).toContain(`${current.name} remote`); expect(rows()).not.toContain('Unrelated');
    expect(error).toHaveBeenCalled(); error.mockRestore();
  });

  it.each([false, true])('rejects Sent results after a From client change (returnToA=%s) without filtering shared contacts', async returnToA => {
    const a = enableSent(), b = mockClient('B');
    useIdentityStore.setState({ identities: await a.self.getIdentities() } as never);
    useAccountStore.setState({ accounts: [
      { id: 'A', isConnected: true, email: 'sender-A@example.test' },
      { id: 'B', isConnected: true, email: 'sender-B@example.test' },
    ] } as never);
    render(<EmailComposer initialData={EMPTY_DATA} />); await advance(0);
    type('Alpha'); await advance(); startServer();
    fireEvent.change(screen.getByTestId('composer-from'), { target: { value: 'B::id' } });
    if (returnToA) fireEvent.change(screen.getByTestId('composer-from'), { target: { value: 'A::id' } });
    await resolve(a.requests[0].gate, serverResponse([suggestion('Alpha old remote')]));
    expect(rows()).toContain('Alpha'); expect(rows()).not.toContain('old remote');
    startServer(); const current = returnToA ? a : b;
    expect(current.self.searchSentRecipients).toHaveBeenLastCalledWith('Alpha', 'sent-A');
    await resolve(current.requests[current.requests.length - 1].gate, serverResponse([suggestion('Alpha current remote')])); expect(rows()).toContain('Alpha current remote');
  });
});
