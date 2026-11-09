import { render, screen, within, fireEvent, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

// Keep the real composer queue and JMAP client; stub unrelated UI and stores.
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
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
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
    onBeforeAttachmentUpload: { intercept: async () => true },
    onBeforeBlobUpload: { transform: async (fileId: unknown) => fileId },
    onAfterAttachmentUpload: { emit: vi.fn() },
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

const progressCleanup = vi.hoisted(() => vi.fn());
vi.mock('@/lib/upload-progress', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/upload-progress')>();
  return { ...original, onUploadProgress: (id: string, listener: (loaded: number, total: number) => void) => {
    const unsubscribe = original.onUploadProgress(id, listener);
    return () => { unsubscribe(); progressCleanup(); };
  } };
});

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


import { RequestTimeoutError } from '@/lib/jmap/client';
import { UploadXHR, uploadClient } from '@/lib/__tests__/helpers/upload-xhr';
import { toast } from '@/stores/toast-store';
import { emailHooks } from '@/lib/plugin-hooks';

const INACTIVITY_MS = 300_000;
const file = (name: string) => new File(['0123456789'], name, { type: 'text/plain' });

async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function select(input: HTMLInputElement, files: File[]) {
  await act(async () => {
    fireEvent.change(input, { target: { files } });
    await vi.advanceTimersByTimeAsync(0);
  });
}

function chip(name: string) {
  const progress = screen.queryByRole('progressbar', { name });
  // Each attachment chip contains its label and cancel/remove button.
  return progress?.parentElement ?? screen.getByText(name).parentElement!.parentElement!.parentElement!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  UploadXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', UploadXHR);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected networking'); }));
});

afterEach(async () => {
  cleanup();
  for (const xhr of UploadXHR.instances) {
    xhr.abort();
    // Drain any queued requests before restoring the synthetic transport.
    await vi.advanceTimersByTimeAsync(0);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAuthStore.setState({ client: null });
});

describe('composer XHR inactivity recovery', () => {
  it.each([0, 10])('releases stalled A after %i uploaded bytes, starts B, and permits removing/re-adding A', async loaded => {
    const client = uploadClient();
    const upload = vi.spyOn(client, 'uploadBlob');
    useAuthStore.setState({ client: client as never });
    render(<EmailComposer
      initialData={{ to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false,
        selectedIdentityId: 'acct-2::id-other', subAddressTag: '', mode: 'compose', draftId: null }}
      onClose={vi.fn()}
    />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const a = file('A.txt');
    await select(input, [a, file('B.txt')]);
    expect(upload).toHaveBeenCalledTimes(1);
    const aXHR = UploadXHR.instances[0];
    if (loaded) {
      await advance(120_000);
      act(() => aXHR.progress(loaded));
    }
    const aOutcome = upload.mock.results[0].value as ReturnType<typeof client.uploadBlob>;
    // Attach the rejection assertion before the fake clock expires the request.
    const result = aOutcome.catch((error: unknown) => error);
    await advance(INACTIVITY_MS - 1);
    expect(screen.getByRole('progressbar', { name: 'A.txt' })).toHaveAttribute('aria-valuenow', String(loaded * 10));
    expect(screen.getByRole('progressbar', { name: 'B.txt' })).not.toHaveAttribute('aria-valuenow');
    expect(toast.error).not.toHaveBeenCalled();
    expect(deleteStagedFile).not.toHaveBeenCalled();
    await advance(1);

    // Timeout must let the existing serial loop reach B.
    expect(upload).toHaveBeenCalledTimes(2);
    expect(await result).toBeInstanceOf(RequestTimeoutError);
    expect(aXHR.abort).toHaveBeenCalledOnce();
    expect(within(chip('A.txt')).getByText('attachment_upload_failed')).toBeTruthy();
    expect(within(chip('A.txt')).queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'B.txt' })).toHaveAttribute('aria-valuenow', '0');
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('upload_failed');
    expect(deleteStagedFile).toHaveBeenCalledTimes(1);
    expect(progressCleanup).toHaveBeenCalledTimes(1);

    act(() => UploadXHR.instances[1].load());
    await advance();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(input.value).toBe('');
    expect(progressCleanup).toHaveBeenCalledTimes(2);
    fireEvent.click(within(chip('A.txt')).getByRole('button', { name: 'recipient_remove A.txt' }));
    expect(screen.queryByText('A.txt')).toBeNull();

    await select(input, [a]);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(upload.mock.calls[2][0]).toBe(a);
    act(() => UploadXHR.instances[2].load());
    await advance();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('attachment_upload_failed')).toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(deleteStagedFile).toHaveBeenCalledTimes(3);
    expect(progressCleanup).toHaveBeenCalledTimes(3);
    expect(emailHooks.onAfterAttachmentUpload.emit).toHaveBeenCalledTimes(2);
    expect(UploadXHR.instances).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
  });
});
