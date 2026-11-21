import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

// #1243: an uploaded blob is only kept for the server's upload TTL while
// nothing references it (RFC 8620 §6.1; an hour by default in Stalwart, a
// minute on the reporter's server). The composer held on to the upload's
// blobId, so a message written for longer than that failed to save and to
// send with "blobId ... does not exist on this server".

// ─── Heavy component mocks (mirrors composer-upload-account.test.tsx) ────────

const editorProps = vi.hoisted(() => ({
  current: null as null | {
    onChange: (html: string) => void;
    onImageUpload: (file: File) => Promise<{ src: string; cid: string } | null>;
  },
}));

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: (props: never) => {
    editorProps.current = props;
    return React.createElement('div', { 'data-testid': 'rich-text-editor' });
  },
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
    onBeforeAttachmentUpload: { intercept: async () => true },
    onBeforeBlobUpload: { transform: async (fileId: unknown) => fileId },
    onAfterAttachmentUpload: { emit: () => {} },
  },
  contactHooks: {
    search: { call: async () => [] },
    onProvideRecipientSuggestions: { transform: async (initial: unknown) => initial },
  },
  isExternalAttachmentResult: () => false,
}));

const { deleteStagedFile } = vi.hoisted(() => ({
  deleteStagedFile: vi.fn(async (_id: string) => {}),
}));

vi.mock('@/lib/plugin-storage', () => ({
  fileStorage: {
    saveFile: async () => {},
    getFile: async () => null,
    deleteFile: deleteStagedFile,
  },
}));

vi.mock('@/lib/upload-progress', () => ({
  onUploadProgress: () => () => {},
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeSignatureHtmlForDisplay: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  sanitizePluginBodyHtml: (v: string) => v,
  escapeHtml: (v: string) => v,
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

const DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Report',
  body: '<p>see attached</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

function mockClient() {
  let uploads = 0;
  let drafts = 0;
  const client = {
    uploadBlob: vi.fn(async (_file: File) => ({ blobId: `upload-${++uploads}` })),
    createDraft: vi.fn(async (..._args: unknown[]) => `draft-${++drafts}`),
    // The saved draft holds the uploaded file as a part with its own blob.
    getEmail: vi.fn(async (id: string) => ({
      id,
      attachments: [
        { partId: '2', blobId: `part-of-${id}`, name: 'report.pdf', type: 'application/pdf', size: 5 },
      ],
    })),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
  };
  useAuthStore.setState({ client: client as never });
  return client;
}

describe('uploads outliving the server\'s upload TTL (#1243)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useAuthStore.setState({ client: null });
    vi.clearAllMocks();
  });

  it('sends an uploaded attachment through the saved draft\'s part, not the upload', async () => {
    vi.useFakeTimers();
    const client = mockClient();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<EmailComposer initialData={DRAFT} onSend={onSend} onClose={vi.fn()} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.uploadBlob).toHaveBeenCalledTimes(1);

    // Autosave puts the upload into a draft ...
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(client.createDraft).toHaveBeenCalledTimes(1);
    expect(client.createDraft.mock.calls[0][8]).toEqual([
      expect.objectContaining({ blobId: 'upload-1', name: 'report.pdf' }),
    ]);

    // ... and the next save no longer depends on the upload.
    fireEvent.change(screen.getByDisplayValue('Report'), { target: { value: 'Report v2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(client.createDraft).toHaveBeenCalledTimes(2);
    expect(client.createDraft.mock.calls[1][8]).toEqual([
      expect.objectContaining({ blobId: 'part-of-draft-1', name: 'report.pdf' }),
    ]);

    await act(async () => {
      fireEvent.click(screen.getAllByTestId('composer-send')[0]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({ blobId: 'part-of-draft-2', name: 'report.pdf' }),
    ]);
  });

  async function composeWithInlineImage(client: ReturnType<typeof mockClient>) {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<EmailComposer initialData={DRAFT} onSend={onSend} onClose={vi.fn()} />);
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'pic.png', { type: 'image/png' });
    let inserted: { src: string; cid: string } | null = null;
    await act(async () => { inserted = await editorProps.current!.onImageUpload(image); });
    expect(inserted).not.toBeNull();
    const { src, cid } = inserted!;
    act(() => editorProps.current!.onChange(`<p>look <img src="${src}" data-cid="${cid}"></p>`));
    expect(client.uploadBlob).toHaveBeenCalledTimes(1);
    return { onSend, cid };
  }

  it('uploads an inline image again when its upload is about to expire', async () => {
    const client = mockClient();
    const { onSend, cid } = await composeWithInlineImage(client);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 60 * 1000);
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    expect(client.uploadBlob).toHaveBeenCalledTimes(2);
    const reuploaded = client.uploadBlob.mock.calls[1][0];
    expect(Array.from(new Uint8Array(await reuploaded.arrayBuffer()))).toEqual([137, 80, 78, 71]);
    expect(reuploaded.type).toBe('image/png');
    expect(onSend.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({ blobId: 'upload-2', cid, disposition: 'inline' }),
    ]);
  });

  it('keeps a fresh inline image upload', async () => {
    const client = mockClient();
    const { onSend, cid } = await composeWithInlineImage(client);

    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    expect(client.uploadBlob).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({ blobId: 'upload-1', cid }),
    ]);
  });
});
