import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer, type ComposerDraftData } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

// ─── Heavy component mocks (mirrors composer-close-guard.test.tsx) ────────────

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
// Two logins of one user, as on the 0.16.23 and 1.0 test servers: the same
// address and the same account id `e` on both.
vi.mock('@/hooks/use-pro-multi-account-identities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-pro-multi-account-identities')>();
  const a = { id: 'login-a::id-a', email: 'me@example.org', name: 'Me', localAccountId: 'login-a' };
  const b = { id: 'login-b::id-b', email: 'me@example.org', name: 'Me', localAccountId: 'login-b' };
  const groups = [
    { localAccountId: 'login-a', accountLabel: 'A', identities: [a] },
    { localAccountId: 'login-b', accountLabel: 'B', identities: [b] },
  ];
  return { ...actual, useProMultiAccountIdentities: () => ({ enabled: true, groups, allIdentities: [a, b] }) };
});

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
    identities: [{ id: 'id-me', email: 'me@example.org', name: 'Me' }],
    defaultIdentityId: 'id-me',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook, notifyIdentitySelected: () => {} };
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
  identityHooks: {
    onSignatureRender: { size: 0, transform: async (value: unknown) => value },
    onIdentitySelect: { size: 0, emit: async () => {} },
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
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: { intercept: async () => true, interceptOutcome: async () => 'allowed' },
    onComposeSend: { intercept: async () => true, takeOver: async () => 'default' },
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

/**
 * A draft is removed through the login it was saved with. Email and account
 * ids repeat across servers: the user's account is `e` on both, and a draft
 * id of one server can name an unrelated message on the other. Switching From
 * to the other login's identity doesn't move the draft until it is saved
 * again - so discarding, replacing and sending must not remove it through the
 * login of the current From.
 */
describe('a draft and the login it was saved with', () => {
  let clientA: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;
  let clientB: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;

  const makeClient = (ids: string[]) => {
    const createDraft = vi.fn();
    for (const id of ids) createDraft.mockResolvedValueOnce(id);
    return {
      createDraft,
      deleteEmail: vi.fn().mockResolvedValue(undefined),
      getEmail: vi.fn(async () => null),
      hasDelayedSend: () => false,
      getMaxDelayedSend: () => 0,
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clientA = makeClient(['draft-a2', 'draft-a3']);
    clientB = makeClient(['draft-b2', 'draft-b3']);
    useAuthStore.setState({
      client: clientA as never,
      activeAccountId: 'login-a' as never,
      getClientForAccount: ((id: string) => (id === 'login-a' ? clientA : id === 'login-b' ? clientB : undefined)) as never,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({ client: null, activeAccountId: null as never, getClientForAccount: (() => undefined) as never });
    vi.clearAllMocks();
  });

  const DRAFT: ComposerDraftData = {
    to: 'bob@example.com', cc: '', bcc: '', subject: 'Hello', body: '<p>x</p>', showCc: false, showBcc: false,
    selectedIdentityId: 'login-a::id-a', subAddressTag: '', mode: 'compose', draftId: 'draft-a1',
  };

  function open(initialData: ComposerDraftData, props: Partial<React.ComponentProps<typeof EmailComposer>> = {}) {
    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    render(<EmailComposer initialData={initialData} requestCloseRef={requestCloseRef} onClose={vi.fn()} {...props} />);
    return {
      editSubject: async (from: string, to: string) => {
        fireEvent.change(screen.getByDisplayValue(from), { target: { value: to } });
        await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      },
      switchFrom: (identityId: string) => fireEvent.change(screen.getByTestId('composer-from'), { target: { value: identityId } }),
      discard: () => {
        // The Discard button asks even when the draft is saved.
        fireEvent.click(screen.getByText('discard'));
        fireEvent.click(within(screen.getByRole('alertdialog')).getByText('discard'));
      },
      send: async () => {
        fireEvent.click(screen.getAllByTestId('composer-send')[0]);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      },
    };
  }

  it('discards through the login the draft was saved with after From moved to another login', async () => {
    const onDiscardDraft = vi.fn();
    const composer = open(DRAFT, { onDiscardDraft });

    await composer.editSubject('Hello', 'Hello 2');
    expect(clientA.createDraft).toHaveBeenCalledTimes(1);
    composer.switchFrom('login-b::id-b');
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    composer.discard();

    expect(onDiscardDraft).toHaveBeenCalledWith('draft-a2', { accountId: undefined, localAccountId: 'login-a' });
  });

  it('saves a new version through the new login and removes the old one through its own', async () => {
    const onDiscardDraft = vi.fn();
    const composer = open(DRAFT, { onDiscardDraft });

    await composer.editSubject('Hello', 'Hello 2');
    composer.switchFrom('login-b::id-b');
    await composer.editSubject('Hello 2', 'Hello 3');

    // Created through B with nothing for B to remove ...
    expect(clientB.createDraft).toHaveBeenCalledTimes(1);
    expect((clientB.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][7]).toBeUndefined();
    expect((clientB.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][13]?.previousDraftAccountId).toBeUndefined();
    // ... the version A saved goes through A, and B removes nothing.
    expect(clientA.deleteEmail).toHaveBeenCalledWith('draft-a2', undefined);
    expect(clientB.deleteEmail).not.toHaveBeenCalled();

    composer.discard();
    expect(onDiscardDraft).toHaveBeenCalledWith('draft-b2', { accountId: undefined, localAccountId: 'login-b' });
  });

  it('keeps replacing versions through createDraft while the login stays the same', async () => {
    const composer = open({ ...DRAFT, draftLocalAccountId: 'login-a' });

    await composer.editSubject('Hello', 'Hello 2');
    await composer.editSubject('Hello 2', 'Hello 3');

    expect((clientA.createDraft as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[7])).toEqual(['draft-a1', 'draft-a2']);
    expect(clientA.deleteEmail).not.toHaveBeenCalled();
  });

  it('sends without handing the draft to the new login, then removes it through the one that saved it', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const composer = open(DRAFT, { onSend });

    await composer.editSubject('Hello', 'Hello 2');
    composer.switchFrom('login-b::id-b');
    await composer.send();

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ localAccountId: 'login-b', draftId: undefined, draftAccountId: undefined }));
    expect(clientA.deleteEmail).toHaveBeenCalledWith('draft-a2', undefined);
    expect(clientB.deleteEmail).not.toHaveBeenCalled();
  });

  it('keeps a draft whose send failed', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('Failed to send'));
    const composer = open(DRAFT, { onSend });

    await composer.editSubject('Hello', 'Hello 2');
    composer.switchFrom('login-b::id-b');
    await composer.send();

    expect(onSend).toHaveBeenCalled();
    expect(clientA.deleteEmail).not.toHaveBeenCalled();
  });

  it('keeps a draft saved through another login when the host sent nothing', async () => {
    // The host has no connection and says so.
    const onSend = vi.fn().mockResolvedValue(false);
    const composer = open(DRAFT, { onSend });

    await composer.editSubject('Hello', 'Hello 2');
    composer.switchFrom('login-b::id-b');
    await composer.send();

    expect(onSend).toHaveBeenCalled();
    expect(clientA.deleteEmail).not.toHaveBeenCalled();
    expect(clientB.deleteEmail).not.toHaveBeenCalled();
  });

  it('removes a draft opened from another login\'s group account through that login', async () => {
    const onDiscardDraft = vi.fn();
    // Opened from login B's unified-view row in the team account `c`; the
    // composer writes as A.
    const composer = open({ ...DRAFT, draftId: 'draft-b1', draftAccountId: 'c', draftLocalAccountId: 'login-b' }, { onDiscardDraft });

    await composer.editSubject('Hello', 'Hello 2');

    expect((clientA.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][7]).toBeUndefined();
    expect(clientB.deleteEmail).toHaveBeenCalledWith('draft-b1', 'c');
    expect(clientA.deleteEmail).not.toHaveBeenCalled();

    composer.discard();
    expect(onDiscardDraft).toHaveBeenCalledWith('draft-a2', { accountId: undefined, localAccountId: 'login-a' });
  });

  it('discards an unsaved draft opened from another login through that login and account', () => {
    const onDiscardDraft = vi.fn();
    const composer = open({ ...DRAFT, draftId: 'draft-b1', draftAccountId: 'c', draftLocalAccountId: 'login-b' }, { onDiscardDraft });

    fireEvent.change(screen.getByDisplayValue('Hello'), { target: { value: 'Hello 2' } });
    composer.discard();

    expect(onDiscardDraft).toHaveBeenCalledWith('draft-b1', { accountId: 'c', localAccountId: 'login-b' });
  });
});
