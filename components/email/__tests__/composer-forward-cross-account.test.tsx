import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

// Forwarding a message reached through another login (unified view) carried
// its attachments along as that account's part blobIds, while the forward was
// saved and sent through the composing account. Stalwart scopes blobs per
// account, so Email/set failed with blobNotFound. The parts must be copied to
// the composing account first - once, and only when the accounts differ.

// ─── Heavy component mocks (mirrors composer-draft-attachments.test.tsx) ─────

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ current: null }),
}));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

// ─── Store mocks ──────────────────────────────────────────────────────────────

vi.mock('@/stores/auth-store', () => {
  const state = {
    client: null,
    identities: [],
    primaryIdentity: null,
    isAuthenticated: false,
    isDemoMode: false,
    activeAccountId: null,
    connectionLost: false,
    getClientForAccount: () => undefined,
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

vi.mock('@/stores/identity-store', () => {
  const state = {
    identities: [{ id: 'id-me', email: 'me@example.com', name: 'Me' }],
    defaultIdentityId: 'id-me',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook };
});

vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAccountStore: hook };
});

vi.mock('@/stores/email-store', () => {
  const state = {
    draftSaveEnabled: false,
    sendRawEmail: async () => ({ sent: true }),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

vi.mock('@/stores/settings-store', () => {
  const state = {
    timeFormat: '24h',
    plainTextMode: false,
    subAddressDelimiter: '+',
    autoSelectReplyIdentity: true,
    attachmentReminderEnabled: false,
    attachmentReminderKeywords: [],
    emptySubjectWarningEnabled: true,
    sendDelaySeconds: 0,
    signaturePosition: 'above_quote',
    signatureSeparatorEnabled: false,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
    updateSetting: () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useSettingsStore: hook };
});

vi.mock('@/stores/contact-store', () => {
  const state = {
    contacts: [],
    getAutocomplete: async () => [],
    addToTrustedSendersBook: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useContactStore: hook };
});

vi.mock('@/stores/template-store', () => {
  const state = { templates: [], addTemplate: async () => {} };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useTemplateStore: hook };
});

// ─── Misc dependency mocks ────────────────────────────────────────────────────

vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: () => {}, success: () => {} },
}));

vi.mock('@/lib/plugin-hooks', () => ({
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: () => {} },
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: { intercept: async () => true },
    onComposeSend: { intercept: async () => true },
    onTransformOutgoingEmail: { transform: async (email: unknown) => email },
  },
  contactHooks: {
    search: { call: async () => [] },
    onProvideRecipientSuggestions: { transform: async (initial: unknown) => initial },
  },
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/signature-utils', () => ({
  appendPlainTextSignature: (body: string) => body,
  getPlainTextSignature: () => '',
  plainTextBodyHasSignature: () => false,
  plainTextBodyWithoutSignature: (body: string) => body,
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

const SCAN = { blobId: 'blob-src', name: 'scan.pdf', type: 'application/pdf', size: 5 };

function mockClients() {
  const composingClient = {
    uploadBlob: vi.fn().mockResolvedValue({ blobId: 'blob-copied' }),
    createDraft: vi.fn()
      .mockResolvedValueOnce('draft-1')
      .mockResolvedValueOnce('draft-2'),
    getEmail: vi.fn().mockResolvedValue({ id: 'draft-1', attachments: [] }),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
  };
  const sourceClient = {
    fetchBlobArrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(5)),
  };
  useAuthStore.setState({
    client: composingClient as never,
    activeAccountId: 'acct-active' as never,
    getClientForAccount: ((id: string) => (
      id === 'acct-src' ? sourceClient : id === 'acct-active' ? composingClient : undefined
    )) as never,
  });
  return { composingClient, sourceClient };
}

async function forwardAndAutosave(sourceClientAccountId?: string) {
  render(
    <EmailComposer
      mode="forward"
      replyTo={{ subject: 'Scans', sourceClientAccountId, attachments: [SCAN] }}
      onClose={vi.fn()}
    />,
  );
  // Make the draft dirty so the autosave debounce arms.
  const subject = screen.getByDisplayValue(/Scans/);
  fireEvent.change(subject, { target: { value: 'Scans for you' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
}

describe('forwarding a message from another account', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({
      client: null,
      activeAccountId: null,
      getClientForAccount: (() => undefined) as never,
    });
    vi.clearAllMocks();
  });

  it('copies the forwarded parts to the composing account before saving', async () => {
    const { composingClient, sourceClient } = mockClients();
    await forwardAndAutosave('acct-src');

    expect(sourceClient.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-src', 'scan.pdf', 'application/pdf');
    expect(composingClient.uploadBlob).toHaveBeenCalledTimes(1);
    const uploaded = composingClient.uploadBlob.mock.calls[0][0] as File;
    expect(uploaded.name).toBe('scan.pdf');
    expect(uploaded.type).toBe('application/pdf');
    expect(composingClient.createDraft).toHaveBeenCalledTimes(1);
    expect(composingClient.createDraft.mock.calls[0][8]).toEqual([
      { blobId: 'blob-copied', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);

    // A later save reuses the copy instead of copying again.
    fireEvent.change(screen.getByDisplayValue('Scans for you'), { target: { value: 'Scans, again' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(composingClient.createDraft).toHaveBeenCalledTimes(2);
    expect(composingClient.createDraft.mock.calls[1][8]).toEqual([
      { blobId: 'blob-copied', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);
    expect(sourceClient.fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
    expect(composingClient.uploadBlob).toHaveBeenCalledTimes(1);
  });

  it('references the original blobs when the message is on the composing account', async () => {
    const { composingClient, sourceClient } = mockClients();
    await forwardAndAutosave('acct-active');

    expect(sourceClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect(composingClient.uploadBlob).not.toHaveBeenCalled();
    expect(composingClient.createDraft.mock.calls[0][8]).toEqual([
      { blobId: 'blob-src', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);
  });

  it('leaves the blobs alone when the originating account is unknown', async () => {
    const { composingClient, sourceClient } = mockClients();
    await forwardAndAutosave(undefined);

    expect(sourceClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect(composingClient.uploadBlob).not.toHaveBeenCalled();
    expect(composingClient.createDraft.mock.calls[0][8]).toEqual([
      { blobId: 'blob-src', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);
  });
});
