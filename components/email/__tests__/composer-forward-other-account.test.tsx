import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import type { AlmostSavedDraft } from '@/lib/plugin-types';

// A forward carries the original message's attachments as part blobIds of the
// account that holds it. When the forward goes out through another account -
// a From from another account's identities - Email/set failed with
// blobNotFound, since blobs are account-scoped. The parts must be copied to
// the composing account first: once, and only when the accounts differ.

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
// Two connected logins. Which identities each one offers is set per test.
const multi = vi.hoisted(() => ({ allIdentities: [] as Array<{ id: string; email: string; name: string }> }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: true, groups: [], allIdentities: multi.allIdentities }),
  stripCrossAccountIdentityPrefix: (id: string) => {
    const at = id.indexOf('::');
    return at < 0 ? { localAccountId: null, rawId: id } : { localAccountId: id.slice(0, at), rawId: id.slice(at + 2) };
  },
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
  const state = { accounts: [], getAccountById: (id: string) => ({ id, isConnected: true }) };
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
    getAutocomplete: () => [],
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

const draftHook = vi.hoisted(() => ({
  enabled: false,
  transform: (draft: AlmostSavedDraft) => draft,
}));

vi.mock('@/lib/plugin-hooks', () => ({
  identityHooks: {
    onSignatureRender: { size: 0, transform: async (value: unknown) => value },
    onIdentitySelect: { size: 0, emit: async () => {} },
    onSelectReplyIdentity: { size: 0 },
  },
  templateHooks: {
    onTemplateRender: { size: 0, transform: async (value: unknown) => value },
    onTemplateApply: { size: 0, emit: async () => {} },
  },
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: () => {} },
    onBeforeDraftAutoSave: {
      get size() { return draftHook.enabled ? 1 : 0; },
      interceptWithValue: async (draft: AlmostSavedDraft) => ({ allowed: true, value: draftHook.transform(draft) }),
    },
    onBeforeEmailSend: { intercept: async () => true, interceptOutcome: async () => 'allowed' },
    onComposeSend: { takeOver: async () => 'default' },
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
const ACTIVE_IDENTITY = { id: 'acct-active::id-me', email: 'me@example.com', name: 'Me' };
const SOURCE_IDENTITY = { id: 'acct-src::id-src', email: 'me@other.example', name: 'Me' };

function draftClient(prefix: string) {
  return {
    getAccountId: () => `${prefix}-primary`,
    resolveSendAccountId: vi.fn().mockResolvedValue(`${prefix}-primary`),
    uploadBlob: vi.fn().mockResolvedValue({ blobId: 'blob-copied' }),
    fetchBlobArrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(5)),
    createDraft: vi.fn()
      .mockResolvedValueOnce(`${prefix}-draft-1`)
      .mockResolvedValueOnce(`${prefix}-draft-2`),
    getEmail: vi.fn().mockResolvedValue({ id: `${prefix}-draft-1`, attachments: [] }),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
  };
}

function mockClients() {
  const activeClient = draftClient('active');
  const sourceClient = draftClient('source');
  useAuthStore.setState({
    client: activeClient as never,
    activeAccountId: 'acct-active' as never,
    getClientForAccount: ((id: string) => (
      id === 'acct-src' ? sourceClient : id === 'acct-active' ? activeClient : undefined
    )) as never,
  });
  return { activeClient, sourceClient };
}

async function forwardAndAutosave(accountId?: string, jmapOwner?: string, sourceLogin = jmapOwner ? accountId : undefined) {
  render(
    <EmailComposer
      mode="forward"
      replyTo={{ subject: 'Scans', accountId, sourceClientAccountId: sourceLogin, sourceAccountId: jmapOwner, attachments: [SCAN] }}
      onClose={vi.fn()}
    />,
  );
  // Make the draft dirty so the autosave debounce arms.
  const subject = screen.getByDisplayValue(/Scans/);
  fireEvent.change(subject, { target: { value: 'Scans for you' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
}

describe('forwarding a message held by another account', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    draftHook.enabled = false;
    draftHook.transform = draft => draft;
    vi.useRealTimers();
    useAuthStore.setState({
      client: null,
      activeAccountId: null,
      getClientForAccount: (() => undefined) as never,
    });
    vi.clearAllMocks();
  });

  it('copies the forwarded parts to the sending account before saving, once', async () => {
    // The holding account has no identity of its own, so the forward goes out
    // from the active account's address.
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient, sourceClient } = mockClients();
    await forwardAndAutosave('acct-src');

    expect(sourceClient.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-src', 'scan.pdf', 'application/pdf');
    expect(activeClient.uploadBlob).toHaveBeenCalledTimes(1);
    const uploaded = activeClient.uploadBlob.mock.calls[0][0] as File;
    expect(uploaded.name).toBe('scan.pdf');
    expect(uploaded.type).toBe('application/pdf');
    expect(activeClient.createDraft).toHaveBeenCalledTimes(1);
    expect(activeClient.createDraft.mock.calls[0][8]).toEqual([
      { blobId: 'blob-copied', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);

    // A later save reuses the copy instead of copying again.
    fireEvent.change(screen.getByDisplayValue('Scans for you'), { target: { value: 'Scans, again' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(activeClient.createDraft).toHaveBeenCalledTimes(2);
    expect(activeClient.createDraft.mock.calls[1][8]).toEqual([
      { blobId: 'blob-copied', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);
    expect(sourceClient.fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
    expect(activeClient.uploadBlob).toHaveBeenCalledTimes(1);
  });

  it('references the original blobs when it goes out from the account that holds them', async () => {
    multi.allIdentities = [ACTIVE_IDENTITY, SOURCE_IDENTITY];
    const { activeClient, sourceClient } = mockClients();
    await forwardAndAutosave('acct-src');

    expect(sourceClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect(sourceClient.uploadBlob).not.toHaveBeenCalled();
    expect(activeClient.createDraft).not.toHaveBeenCalled();
    expect(sourceClient.createDraft.mock.calls[0][8]).toEqual([
      { blobId: 'blob-src', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);
  });

  it('still copies the parts of a forward restored before its first save', async () => {
    // A pro tab move or an unmount stashes the composer before the autosave
    // ran: the restored attachments still hold the other account's blobs.
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient, sourceClient } = mockClients();
    render(
      <EmailComposer
        mode="forward"
        replyTo={{ subject: 'Scans', accountId: 'acct-src', attachments: [SCAN] }}
        initialData={{
          to: '', cc: '', bcc: '', subject: 'Scans', body: '',
          showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '',
          mode: 'forward', draftId: null,
          attachments: [{ ...SCAN, sourceAccountId: 'acct-src' }],
        }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByDisplayValue(/Scans/), { target: { value: 'Scans for you' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(sourceClient.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-src', 'scan.pdf', 'application/pdf');
    expect(activeClient.createDraft.mock.calls[0][8]).toEqual([
      { blobId: 'blob-copied', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);
  });

  it('sends the copies, and does not send when a part cannot be copied', async () => {
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient, sourceClient } = mockClients();
    const NOTES = { blobId: 'blob-notes', name: 'notes.txt', type: 'text/plain', size: 3 };
    // The second part cannot be downloaded until the holding login is back.
    let notesReachable = false;
    sourceClient.fetchBlobArrayBuffer.mockImplementation(async (blobId: string) => {
      if (blobId === 'blob-notes' && !notesReachable) throw new Error('download failed');
      return new ArrayBuffer(5);
    });
    activeClient.uploadBlob
      .mockResolvedValueOnce({ blobId: 'blob-scan-copy' })
      .mockResolvedValueOnce({ blobId: 'blob-notes-copy' });
    const onSend = vi.fn();
    render(
      <EmailComposer
        mode="forward"
        replyTo={{ subject: 'Scans', accountId: 'acct-src', attachments: [SCAN, NOTES] }}
        onSend={onSend}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('to_placeholder'), { target: { value: 'friend@example.com' } });

    const send = async () => {
      fireEvent.click(screen.getAllByTestId('composer-send')[0]);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    };
    await send();
    expect(onSend).not.toHaveBeenCalled();
    expect(activeClient.uploadBlob).toHaveBeenCalledTimes(1);

    // The retry copies only the part that failed.
    notesReachable = true;
    await send();
    expect(sourceClient.fetchBlobArrayBuffer.mock.calls.filter(([id]) => id === 'blob-src')).toHaveLength(1);
    expect(activeClient.uploadBlob).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].attachments).toEqual([
      { blobId: 'blob-scan-copy', name: 'scan.pdf', type: 'application/pdf', size: 5 },
      { blobId: 'blob-notes-copy', name: 'notes.txt', type: 'text/plain', size: 3 },
    ]);
  });

  it('keeps a renamed forwarded part under its new name when it is copied over', async () => {
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient } = mockClients();
    render(
      <EmailComposer
        mode="forward"
        replyTo={{ subject: 'Scans', accountId: 'acct-src', attachments: [SCAN] }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('composer-rename'));
    fireEvent.change(screen.getByRole('textbox', { name: 'rename_title' }), { target: { value: 'Signed contract' } });
    fireEvent.click(screen.getByRole('button', { name: 'rename' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(activeClient.createDraft.mock.calls[0][8]).toEqual([
      { blobId: 'blob-copied', name: 'Signed contract.pdf', type: 'application/pdf', size: 5 },
    ]);
  });

  it('copies only the parts tagged with another account in a mixed batch forward', async () => {
    // Forward as attachments from the Unified Inbox: one message on the
    // active login, one on another. No single replyTo.accountId fits both.
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient, sourceClient } = mockClients();
    const LOCAL = { blobId: 'blob-local', name: 'local.eml', type: 'message/rfc822', size: 7 };
    render(
      <EmailComposer
        mode="forward"
        replyTo={{ subject: 'Scans', attachments: [LOCAL, { ...SCAN, sourceAccountId: 'acct-src' }] }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByDisplayValue(/Scans/), { target: { value: 'Scans for you' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(sourceClient.fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
    expect(sourceClient.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-src', 'scan.pdf', 'application/pdf');
    expect(activeClient.createDraft.mock.calls[0][8]).toEqual([
      LOCAL,
      { blobId: 'blob-copied', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);
  });

  it('leaves the blobs alone for a message on the active account', async () => {
    multi.allIdentities = [ACTIVE_IDENTITY, SOURCE_IDENTITY];
    const { activeClient, sourceClient } = mockClients();
    await forwardAndAutosave(undefined);

    expect(sourceClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect(activeClient.uploadBlob).not.toHaveBeenCalled();
    expect(activeClient.createDraft.mock.calls[0][8]).toEqual([
      { blobId: 'blob-src', name: 'scan.pdf', type: 'application/pdf', size: 5 },
    ]);
  });

  it('copies an attachment from a delegated JMAP owner into the active login draft account', async () => {
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient, sourceClient } = mockClients();
    const owner = 'shared-owner';
    await forwardAndAutosave('acct-active', owner);

    expect.soft(activeClient.fetchBlobArrayBuffer).toHaveBeenCalledExactlyOnceWith(
      SCAN.blobId, SCAN.name, SCAN.type, owner,
    );
    expect.soft(sourceClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect.soft(activeClient.uploadBlob).toHaveBeenCalledExactlyOnceWith(expect.any(File), 'active-primary');
    expect.soft(activeClient.createDraft.mock.calls[0]?.[8]).toEqual([
      { ...SCAN, blobId: 'blob-copied' },
    ]);
  });

  it('copies from the source primary into the resolved group draft account and reuses the saved part', async () => {
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient } = mockClients();
    activeClient.resolveSendAccountId.mockResolvedValue('group-drafts');
    activeClient.getEmail.mockResolvedValue({ attachments: [{ ...SCAN, blobId: 'saved-part' }] });
    await forwardAndAutosave('acct-active', undefined, 'acct-active');

    expect(activeClient.fetchBlobArrayBuffer).toHaveBeenCalledExactlyOnceWith(
      SCAN.blobId, SCAN.name, SCAN.type, 'active-primary',
    );
    expect(activeClient.uploadBlob).toHaveBeenCalledExactlyOnceWith(expect.any(File), 'group-drafts');
    expect(activeClient.createDraft.mock.calls[0][8]).toEqual([{ ...SCAN, blobId: 'blob-copied' }]);
    expect(activeClient.createDraft.mock.calls[0][13]).toMatchObject({ accountId: 'group-drafts' });
    expect(activeClient.getEmail).toHaveBeenCalledWith('active-draft-1', 'group-drafts');

    fireEvent.change(screen.getByDisplayValue('Scans for you'), { target: { value: 'Scans, again' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(activeClient.fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
    expect(activeClient.uploadBlob).toHaveBeenCalledTimes(1);
    expect(activeClient.createDraft.mock.calls[1][8]).toEqual([{ ...SCAN, blobId: 'saved-part' }]);
  });

  it.each([
    { login: 'acct-active', copy: false },
    { login: 'acct-src', copy: true },
  ])('compares the login as well as the resolved JMAP owner ($login)', async ({ login, copy }) => {
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient, sourceClient } = mockClients();
    activeClient.resolveSendAccountId.mockResolvedValue('shared-owner');
    await forwardAndAutosave(login, 'shared-owner');

    expect(activeClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    if (copy) {
      expect(sourceClient.fetchBlobArrayBuffer).toHaveBeenCalledExactlyOnceWith(
        SCAN.blobId, SCAN.name, SCAN.type, 'shared-owner',
      );
      expect(activeClient.uploadBlob).toHaveBeenCalledExactlyOnceWith(expect.any(File), 'shared-owner');
    } else {
      expect(sourceClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
      expect(activeClient.uploadBlob).not.toHaveBeenCalled();
    }
    expect(activeClient.createDraft.mock.calls[0][8]).toEqual([
      { ...SCAN, blobId: copy ? 'blob-copied' : SCAN.blobId },
    ]);
  });

  it('sends a restored forward using the saved source owner and resolved outgoing owner', async () => {
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient } = mockClients();
    activeClient.resolveSendAccountId.mockResolvedValue('group-send');
    const onSaveState = vi.fn();
    const onSend = vi.fn();
    const original = render(
      <EmailComposer
        mode="forward"
        replyTo={{ subject: 'Scans', sourceClientAccountId: 'acct-active', sourceAccountId: 'shared-owner', attachments: [SCAN] }}
        onSaveState={onSaveState}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('to_placeholder'), { target: { value: 'friend@example.com' } });
    original.unmount();

    const savedState = onSaveState.mock.calls[0][0];
    expect(savedState.attachments).toEqual([
      { ...SCAN, sourceAccountId: 'acct-active', sourceJmapAccountId: 'shared-owner' },
    ]);

    // Exercise Send's copy even when there is no autosave to flush.
    render(<EmailComposer initialData={{ ...savedState, unsaved: false }} onSend={onSend} />);
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(activeClient.createDraft).not.toHaveBeenCalled();
    expect(activeClient.resolveSendAccountId).toHaveBeenCalledWith(ACTIVE_IDENTITY.email);
    expect(activeClient.fetchBlobArrayBuffer.mock.calls).toEqual([
      [SCAN.blobId, SCAN.name, SCAN.type, 'shared-owner'],
      ['blob-copied', SCAN.name, SCAN.type, 'group-send', expect.any(Number)],
    ]);
    expect(activeClient.uploadBlob).toHaveBeenCalledExactlyOnceWith(expect.any(File), 'group-send');
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ attachments: [{ ...SCAN, blobId: 'blob-copied' }] }),
      expect.objectContaining({
        attachments: [{ ...SCAN, blobId: 'blob-copied', sourceAccountId: 'acct-active', sourceJmapAccountId: 'group-send' }],
      }),
    );
  });

  it('keeps local and foreign attachments with the same id distinct with a draft hook', async () => {
    draftHook.enabled = true;
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient, sourceClient } = mockClients();
    const local = { ...SCAN, name: 'local.pdf' };
    const foreign = { ...SCAN, name: 'foreign.pdf' };
    render(<EmailComposer mode="forward" replyTo={{
      subject: 'Files', attachments: [local, { ...foreign, sourceAccountId: 'acct-src' }],
    }} onClose={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue(/Files/), { target: { value: 'Forwarded files' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(sourceClient.fetchBlobArrayBuffer).toHaveBeenCalledExactlyOnceWith(foreign.blobId, foreign.name, foreign.type);
    expect(activeClient.uploadBlob).toHaveBeenCalledTimes(1);
    expect(activeClient.createDraft.mock.calls[0][8]).toEqual([
      local, { ...foreign, blobId: 'blob-copied' },
    ]);
  });

  it('preserves the source of identical-looking attachments cloned and reordered by a draft hook', async () => {
    draftHook.enabled = true;
    draftHook.transform = draft => ({
      ...draft,
      attachments: structuredClone(draft.attachments)?.reverse(),
    });
    multi.allIdentities = [ACTIVE_IDENTITY];
    const { activeClient } = mockClients();
    render(<EmailComposer mode="forward" replyTo={{
      subject: 'Files', attachments: [SCAN, { ...SCAN, sourceAccountId: 'acct-src' }],
    }} onClose={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue(/Files/), { target: { value: 'Forwarded files' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(activeClient.createDraft.mock.calls[0][8]).toEqual([
      { ...SCAN, blobId: 'blob-copied' }, SCAN,
    ]);
  });
});
