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
        onClick: () =>
          onAttach?.({ blobId: 'cloud-blob-1', name: 'vacation.jpg', type: 'image/jpeg', size: 42_000 }),
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
    expect(screen.getByText('vacation.jpg')).toBeInTheDocument();

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
