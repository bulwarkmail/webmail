import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
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

/**
 * #849: a re-opened draft brings its server-side attachments along via
 * initialData. They must show up as chips, be included in the next save, and
 * after every save their blobIds must be re-pointed at the parts of the newly
 * created draft version - the old version's part blobs die with it, so a
 * second save through stale blobIds fails and (before the create/destroy
 * reorder) used to take the whole draft with it.
 */

const REOPENED_DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Quarterly numbers',
  body: '<p>see attached</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: 'draft-v1',
  attachments: [
    { blobId: 'part-blob-v1', name: 'report.pdf', type: 'application/pdf', size: 1234 },
  ],
};

function mockClient() {
  const createDraft = vi.fn()
    .mockResolvedValueOnce('draft-v2')
    .mockResolvedValueOnce('draft-v3');
  const getEmail = vi.fn().mockImplementation(async (id: string) => ({
    id,
    attachments: [
      { partId: '2', blobId: `part-blob-of-${id}`, name: 'report.pdf', type: 'application/pdf', size: 1234 },
    ],
  }));
  const client = {
    createDraft,
    getEmail,
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
  };
  useAuthStore.setState({ client: client as never });
  return { createDraft, getEmail };
}

describe('re-opened draft attachments (#849)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({ client: null });
    vi.clearAllMocks();
  });

  it('shows the existing attachments of a re-opened draft', () => {
    mockClient();
    render(<EmailComposer initialData={REOPENED_DRAFT} onClose={vi.fn()} />);

    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });

  it('carries the attachments through saves and re-resolves their blobIds each time', async () => {
    const { createDraft, getEmail } = mockClient();
    render(<EmailComposer initialData={REOPENED_DRAFT} onClose={vi.fn()} />);

    // Make the draft dirty so the autosave debounce arms.
    fireEvent.change(screen.getByDisplayValue('Quarterly numbers'), {
      target: { value: 'Quarterly numbers v2' },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    // First save replaces draft-v1 and still references its attachment.
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][7]).toBe('draft-v1');
    expect(createDraft.mock.calls[0][8]).toEqual([
      expect.objectContaining({ blobId: 'part-blob-v1', name: 'report.pdf', size: 1234 }),
    ]);
    // ... after which the blobId is re-resolved against the new version.
    // Re-resolved in the account the draft was saved in (primary here: the mock
    // client has no resolveSendAccountId).
    expect(getEmail).toHaveBeenCalledWith('draft-v2', undefined);

    // The re-resolution itself must not count as a change: no phantom
    // save loop from the blobId swap.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(createDraft).toHaveBeenCalledTimes(1);

    // Second edit: the save must reference the *new* version's part blob -
    // the old one died when draft-v1 was destroyed.
    fireEvent.change(screen.getByDisplayValue('Quarterly numbers v2'), {
      target: { value: 'Quarterly numbers v3' },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(createDraft.mock.calls[1][7]).toBe('draft-v2');
    expect(createDraft.mock.calls[1][8]).toEqual([
      expect.objectContaining({ blobId: 'part-blob-of-draft-v2', name: 'report.pdf', size: 1234 }),
    ]);
  });

  it('marks the draft dirty when a hydrated attachment is removed', async () => {
    const { createDraft } = mockClient();
    render(<EmailComposer initialData={REOPENED_DRAFT} onClose={vi.fn()} />);

    // Removing the only attachment used to not count as dirty (`>` compare),
    // so the removal never reached the server. The remove control is the
    // chip's last button (the X, which carries no stable label).
    const chip = screen.getByText('report.pdf').closest('.rounded-md') as HTMLElement;
    const chipButtons = within(chip).getAllByRole('button');
    fireEvent.click(chipButtons[chipButtons.length - 1]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][8]).toEqual([]);
  });
});

/**
 * An undone send from a group identity is back in the group account's Drafts
 * (Stalwart 1.0 and 0.16.23 file group mail there, beside its submission).
 * Email ids repeat across accounts - live, `eaaaaab` is userb's own first
 * message and the team account's too - so every step that removes the old
 * version must name the account it lives in.
 */
const GROUP_DRAFT = { ...REOPENED_DRAFT, draftId: 'eaaaaab', draftAccountId: 'c', attachments: [] };

describe('a re-opened draft that lives in a group account', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({ client: null });
    vi.clearAllMocks();
  });

  async function editSubject(from: string, to: string) {
    fireEvent.change(screen.getByDisplayValue(from), { target: { value: to } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  }

  it('removes the old version in the group account on the first save, then saves as usual', async () => {
    const { createDraft } = mockClient();
    render(<EmailComposer initialData={GROUP_DRAFT} onClose={vi.fn()} />);

    await editSubject('Quarterly numbers', 'Quarterly numbers v2');
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][7]).toBe('eaaaaab');
    expect(createDraft.mock.calls[0][13]?.previousDraftAccountId).toBe('c');

    // The new version was saved in the own Drafts, like every draft.
    await editSubject('Quarterly numbers v2', 'Quarterly numbers v3');
    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(createDraft.mock.calls[1][7]).toBe('draft-v2');
    expect(createDraft.mock.calls[1][13]?.previousDraftAccountId).toBeUndefined();
  });

  it('tells the host where the draft lives when it is sent unchanged', async () => {
    mockClient();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<EmailComposer initialData={GROUP_DRAFT} onSend={onSend} />);

    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'eaaaaab', draftAccountId: 'c' }));
  });

  it('sends a version saved on the way without the group account', async () => {
    const { createDraft } = mockClient();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<EmailComposer initialData={GROUP_DRAFT} onSend={onSend} />);

    // Edited, and sent before the autosave ran: the send saves first.
    fireEvent.change(screen.getByDisplayValue('Quarterly numbers'), { target: { value: 'Quarterly numbers v2' } });
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(createDraft.mock.calls[0][13]?.previousDraftAccountId).toBe('c');
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft-v2', draftAccountId: undefined }));
  });

  it('tells the host where the draft lives when it is discarded', async () => {
    mockClient();
    const onDiscardDraft = vi.fn();
    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    render(<EmailComposer initialData={GROUP_DRAFT} onDiscardDraft={onDiscardDraft} requestCloseRef={requestCloseRef} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('Quarterly numbers'), { target: { value: 'Quarterly numbers v2' } });
    act(() => requestCloseRef.current!());
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('discard'));

    expect(onDiscardDraft).toHaveBeenCalledWith('eaaaaab', { accountId: 'c', localAccountId: undefined });
  });

  it('keeps an own draft in the own account throughout', async () => {
    const { createDraft } = mockClient();
    const onDiscardDraft = vi.fn();
    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    render(<EmailComposer initialData={REOPENED_DRAFT} onDiscardDraft={onDiscardDraft} requestCloseRef={requestCloseRef} onClose={vi.fn()} />);

    await editSubject('Quarterly numbers', 'Quarterly numbers v2');
    expect(createDraft.mock.calls[0][7]).toBe('draft-v1');
    expect(createDraft.mock.calls[0][13]?.previousDraftAccountId).toBeUndefined();

    fireEvent.change(screen.getByDisplayValue('Quarterly numbers v2'), { target: { value: 'Quarterly numbers v3' } });
    act(() => requestCloseRef.current!());
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('discard'));
    expect(onDiscardDraft).toHaveBeenCalledWith('draft-v2', { accountId: undefined, localAccountId: undefined });
  });
});
