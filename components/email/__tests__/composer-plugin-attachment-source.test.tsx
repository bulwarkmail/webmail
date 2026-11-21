import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

// ─── Heavy component mocks (mirrors composer-draft-attachments.test.tsx) ─────

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}));

// A stand-in "cloud storage" plugin: renders a single button for the
// composer-attachment-source slot which, on click, calls the `onAttach`
// callback the host passed through extraProps - exactly what a real plugin
// does after it has uploaded a picked file to JMAP itself (api.jmap.uploadBlob).
// Every other slot renders nothing, matching the rest of the test suite.
// The composer only renders its plugin row when a plugin offers a slot.
vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: (slot: string) => (slot === 'composer-attachment-source' ? [{ pluginId: 'p', order: 100 }] : []),
}));
const attachState = vi.hoisted(() => ({
  next: { blobId: 'cloud-blob-1', name: 'vacation.jpg', type: 'image/jpeg', size: 42_000 } as Record<string, unknown>,
  allow: true,
}));
vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: ({ name, extraProps }: { name: string; extraProps?: Record<string, unknown> }) => {
    if (name !== 'composer-attachment-source') return null;
    const onAttach = extraProps?.onAttach as
      | ((f: { blobId: string; name: string; type: string; size: number }) => void)
      | undefined;
    return React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'fake-cloud-storage-plugin',
        onClick: () => onAttach?.(attachState.next as never),
      },
      'Attach from cloud storage',
    );
  },
}));

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
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: { intercept: async () => true, interceptOutcome: async () => 'allowed' },
    onComposeSend: { takeOver: async () => 'default' },
    onTransformOutgoingEmail: { transform: async (email: unknown) => email },
    onBeforeAttachmentUpload: { intercept: async () => attachState.allow },
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
 * A plugin rendered into the composer-attachment-source slot (e.g. a WebDAV /
 * cloud-storage file browser) uploads the file it picked to JMAP itself, then
 * calls the `onAttach` callback the host handed it via extraProps to have the
 * result added to the draft - without ever touching the local file picker or
 * drag-drop path.
 */
describe('composer-attachment-source plugin slot', () => {
  afterEach(() => {
    useAuthStore.setState({ client: null });
    vi.clearAllMocks();
    attachState.next = { blobId: 'cloud-blob-1', name: 'vacation.jpg', type: 'image/jpeg', size: 42_000 };
    attachState.allow = true;
  });

  it('ignores something from a plugin that is not an attachment', async () => {
    attachState.next = { blobId: 'not a blob id', name: 'evil.jpg', type: 'image/jpeg', size: 1 };
    render(<EmailComposer onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('fake-cloud-storage-plugin'));

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('evil.jpg')).not.toBeInTheDocument();
  });

  it('applies the same attachment checks as a local file', async () => {
    // A plugin's onBeforeAttachmentUpload guard used to be skipped here.
    attachState.allow = false;
    render(<EmailComposer onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('fake-cloud-storage-plugin'));

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('vacation.jpg')).not.toBeInTheDocument();
  });

  it('adds a plugin-supplied blob as an attachment chip when onAttach is called', async () => {
    render(<EmailComposer onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('fake-cloud-storage-plugin'));

    expect(await screen.findByText('vacation.jpg')).toBeInTheDocument();
  });

  it('includes the plugin-supplied attachment (by blobId, no local File) in the next save', async () => {
    const createDraft = vi.fn().mockResolvedValueOnce('draft-1');
    useAuthStore.setState({
      client: {
        createDraft,
        getEmail: vi.fn(),
        hasDelayedSend: () => false,
        getMaxDelayedSend: () => 0,
      } as never,
    });

    render(<EmailComposer onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('fake-cloud-storage-plugin'));
    expect(await screen.findByText('vacation.jpg')).toBeInTheDocument();

    // Fake timers only from here on - the autosave debounce below needs
    // vi.advanceTimersByTimeAsync, but findBy*'s own internal polling (not
    // used above, kept in mind for future edits to this test) would hang
    // forever under fake time with nothing driving it forward.
    vi.useFakeTimers();

    // Any edit marks the draft dirty and arms the autosave debounce.
    fireEvent.change(screen.getByPlaceholderText(/subject/i), {
      target: { value: 'Photos from the trip' },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][8]).toEqual([
      expect.objectContaining({ blobId: 'cloud-blob-1', name: 'vacation.jpg', size: 42_000 }),
    ]);

    vi.useRealTimers();
  });
});
