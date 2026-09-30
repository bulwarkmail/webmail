import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

// #943: attachments (and pasted inline images) were uploaded through the
// ACTIVE account's client while the draft itself is created through the
// composing identity's account (`composerClient`). The blob then belongs to
// the wrong account and the draft save fails. Uploads must go through the
// same client as createDraft.

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
// The selected identity is namespaced with the local account that owns it.
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => {
    const idx = id.indexOf('::');
    return idx === -1
      ? { localAccountId: null, rawId: id }
      : { localAccountId: id.slice(0, idx), rawId: id.slice(idx + 2) };
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
    identities: [{ id: 'acct-2::id-other', email: 'other@example.com', name: 'Other' }],
    defaultIdentityId: 'acct-2::id-other',
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

function mockClients() {
  const activeClient = {
    uploadBlob: vi.fn().mockResolvedValue({ blobId: 'blob-active' }),
    createDraft: vi.fn().mockResolvedValue('draft-1'),
    getEmail: vi.fn().mockResolvedValue({ id: 'draft-1', attachments: [] }),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
  };
  const otherClient = {
    uploadBlob: vi.fn().mockResolvedValue({ blobId: 'blob-other' }),
    createDraft: vi.fn().mockResolvedValue('draft-2'),
    getEmail: vi.fn().mockResolvedValue({ id: 'draft-2', attachments: [] }),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
  };
  useAuthStore.setState({
    client: activeClient as never,
    getClientForAccount: ((id: string) => (id === 'acct-2' ? otherClient : undefined)) as never,
  });
  return { activeClient, otherClient };
}

describe('composer attachment upload account (#943)', () => {
  afterEach(() => {
    useAuthStore.setState({ client: null, getClientForAccount: (() => undefined) as never });
    vi.clearAllMocks();
  });

  it('uploads through the composing identity\'s client, not the active one', async () => {
    const { activeClient, otherClient } = mockClients();
    render(
      <EmailComposer
        initialData={{
          to: '',
          cc: '',
          bcc: '',
          subject: '',
          body: '',
          showCc: false,
          showBcc: false,
          selectedIdentityId: 'acct-2::id-other',
          subAddressTag: '',
          mode: 'compose',
          draftId: null,
        }}
        onClose={vi.fn()}
      />,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      // Let the upload chain (hooks, staging, upload) settle.
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(otherClient.uploadBlob).toHaveBeenCalledTimes(1);
    expect(otherClient.uploadBlob.mock.calls[0][0]).toBe(file);
    expect(activeClient.uploadBlob).not.toHaveBeenCalled();
  });

  // Firefox backs a File read from IndexedDB with the stored record; deleting
  // the staged copy before the upload finished made XHR send 0 bytes under
  // the full Content-Length (nginx 400).
  it('keeps the staged file until the upload has finished', async () => {
    const { otherClient } = mockClients();
    let finishUpload!: (v: { blobId: string }) => void;
    otherClient.uploadBlob.mockImplementation(
      () => new Promise((resolve) => { finishUpload = resolve; }),
    );
    render(
      <EmailComposer
        initialData={{
          to: '',
          cc: '',
          bcc: '',
          subject: '',
          body: '',
          showCc: false,
          showBcc: false,
          selectedIdentityId: 'acct-2::id-other',
          subAddressTag: '',
          mode: 'compose',
          draftId: null,
        }}
        onClose={vi.fn()}
      />,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(otherClient.uploadBlob).toHaveBeenCalledTimes(1);
    expect(deleteStagedFile).not.toHaveBeenCalled();

    await act(async () => {
      finishUpload({ blobId: 'blob-other' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(deleteStagedFile).toHaveBeenCalledTimes(1);
  });

  it('does not upload files over the server limits', async () => {
    const { otherClient } = mockClients();
    Object.assign(otherClient, { getMaxSizeUpload: () => 10, getMaxSizeAttachmentsPerEmail: () => 12 });
    render(
      <EmailComposer
        initialData={{
          to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false,
          selectedIdentityId: 'acct-2::id-other', subAddressTag: '', mode: 'compose', draftId: null,
        }}
        onClose={vi.fn()}
      />,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const tooBig = new File(['x'.repeat(11)], 'big.txt', { type: 'text/plain' });
    const first = new File(['x'.repeat(8)], 'a.txt', { type: 'text/plain' });
    const second = new File(['x'.repeat(8)], 'b.txt', { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [tooBig, first, second] } });
      await new Promise((r) => setTimeout(r, 0));
    });

    // big.txt is over the per-file limit; b.txt would push the message past 12.
    expect(otherClient.uploadBlob).toHaveBeenCalledTimes(1);
    expect(otherClient.uploadBlob.mock.calls[0][0]).toBe(first);
  });
});
