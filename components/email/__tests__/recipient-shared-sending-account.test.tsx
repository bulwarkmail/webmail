import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Sending from a shared mailbox's address, the composer asks for that
// account's recent recipients too, locally and in "search the server".
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

type Suggestion = { name: string; email: string };
const EMPTY_DATA = {
  to: '', cc: '', bcc: '', subject: '', body: '', showCc: true, showBcc: true,
  selectedIdentityId: null, subAddressTag: '', mode: 'compose' as const, draftId: null,
};
const own = { id: 'own-id', name: 'Me', email: 'me@example.test' };
const team = { id: 'team-id', name: 'Team', email: 'team@shared.test' };
const input = () => screen.getAllByRole('combobox').filter(e => e.tagName === 'INPUT')[0] as HTMLInputElement;
function type(value: string) {
  act(() => input().focus());
  fireEvent.change(input(), { target: { value } });
}
const advance = async (ms = 200) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const rows = () => screen.queryAllByRole('option').filter(e => e.tagName === 'BUTTON').map(e => e.textContent).join('|');
const pickFrom = async (id: string) => {
  fireEvent.change(screen.getByTestId('composer-from'), { target: { value: id } });
  await advance(0);
};
const startServer = () => fireEvent.mouseDown(screen.getByRole('button', { name: 'autocomplete_search_server' }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let client: IJMAPClient;
let getAutocomplete: ReturnType<typeof vi.fn>;
let searches: Array<{ args: unknown[]; gate: ReturnType<typeof deferred<Suggestion[]>> }>;

beforeEach(() => {
  vi.useFakeTimers();
  clients.clear();
  client = {
    getAccountId: () => 'primary',
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
    resolveSendAccountId: vi.fn(async (from?: string) => (from === team.email ? 'shared-team' : 'primary')),
  } as unknown as IJMAPClient;
  clients.set('A', client);
  useAuthStore.setState({ client, activeAccountId: 'A' } as never);
  useIdentityStore.setState({ identities: [own, team], defaultIdentityId: own.id } as never);
  useAccountStore.setState({ accounts: [] } as never);
  searches = [];
  getAutocomplete = vi.fn(() => [{ name: 'Alpha', email: 'alpha@example.test' }]);
  useContactStore.setState({
    sentMailboxId: 'sent',
    getAutocomplete,
    searchRecipients: vi.fn((...args: unknown[]) => {
      const gate = deferred<Suggestion[]>();
      searches.push({ args, gate });
      return gate.promise;
    }),
  } as never);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in recipient test'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recipient suggestions for a From on a shared account', () => {
  it('passes the shared account to the local and the server lookup, and drops it for the own From', async () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    await pickFrom(team.id);
    expect(client.resolveSendAccountId).toHaveBeenLastCalledWith(team.email);

    type('Al'); await advance();
    expect(getAutocomplete).toHaveBeenLastCalledWith('Al', { sendingAccountId: 'shared-team' });
    startServer();
    expect(searches[0].args).toEqual([client, 'Al', 'shared-team']);
    await act(async () => { searches[0].gate.resolve([]); await searches[0].gate.promise; });

    await pickFrom(own.id);
    type('Alp'); await advance();
    expect(getAutocomplete).toHaveBeenLastCalledWith('Alp', { sendingAccountId: undefined });
    startServer();
    expect(searches[1].args).toEqual([client, 'Alp', undefined]);
  });

  it('drops server results of the shared account once the From changes during the search', async () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    await pickFrom(team.id);
    type('Al'); await advance(); startServer();

    await pickFrom(own.id);
    await act(async () => { searches[0].gate.resolve([{ name: 'Al Team', email: 'al@team.test' }]); await searches[0].gate.promise; });
    expect(rows()).toContain('Alpha');
    expect(rows()).not.toContain('Al Team');

    startServer();
    expect(searches[1].args).toEqual([client, 'Al', undefined]);
    await act(async () => { searches[1].gate.resolve([{ name: 'Al Own', email: 'al@own.test' }]); await searches[1].gate.promise; });
    expect(rows()).toContain('Al Own');
  });

  it('keeps the own suggestions when the sending account cannot be resolved', async () => {
    (client.resolveSendAccountId as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    render(<EmailComposer initialData={EMPTY_DATA} />);
    await pickFrom(team.id);
    type('Al'); await advance();
    expect(getAutocomplete).toHaveBeenLastCalledWith('Al', { sendingAccountId: undefined });
    expect(rows()).toContain('Alpha');
  });
});
