import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import type { FileNode } from '@/lib/jmap/types';

// Attaching files from the Files app (#1179). The picker itself is covered by
// file-picker-dialog.test.tsx; here it is a stub that hands back fixed nodes.

const hoisted = vi.hoisted(() => ({
  picked: [] as unknown[],
  beforeAttachmentUpload: vi.fn(async (_info: { name: string }) => true),
  toastError: vi.fn(),
}));

vi.mock('@/components/files/file-picker-dialog', () => ({
  FilePickerDialog: ({ onPick }: { onPick: (nodes: unknown[]) => void }) =>
    React.createElement(
      'button',
      { type: 'button', 'data-testid': 'fake-file-picker', onClick: () => onPick(hoisted.picked) },
      'pick',
    ),
}));

// ─── Heavy component mocks (mirrors composer-plugin-attachment-source.test.tsx) ─

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
  toast: { info: () => {}, error: hoisted.toastError, success: () => {} },
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
    onBeforeAttachmentUpload: { intercept: hoisted.beforeAttachmentUpload },
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

function fileNode(id: string, name: string, size: number): FileNode {
  return {
    id, name, size,
    parentId: null,
    type: 'application/pdf',
    blobId: `blob-${id}`,
    created: '2026-10-01T00:00:00Z',
    modified: '2026-10-01T00:00:00Z',
  };
}

function filesClient(overrides: Record<string, unknown> = {}) {
  return {
    createDraft: vi.fn().mockResolvedValue('draft-1'),
    getEmail: vi.fn(),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
    supportsFiles: () => true,
    getMaxSizeAttachmentsPerEmail: () => 0,
    ...overrides,
  };
}

function pickFromFiles(nodes: FileNode[]) {
  hoisted.picked = nodes;
  fireEvent.click(screen.getByTestId('composer-attach-from-files'));
  fireEvent.click(screen.getByTestId('fake-file-picker'));
}

describe('attach from Files', () => {
  afterEach(() => {
    useAuthStore.setState({ client: null });
    vi.clearAllMocks();
    hoisted.beforeAttachmentUpload.mockImplementation(async () => true);
  });

  it('only offers the button when the account has Files', () => {
    useAuthStore.setState({ client: filesClient({ supportsFiles: () => false }) as never });
    render(<EmailComposer onClose={vi.fn()} />);
    expect(screen.queryByTestId('composer-attach-from-files')).toBeNull();
  });

  it('attaches the picked files by their blobId and saves them with the draft', async () => {
    const client = filesClient();
    useAuthStore.setState({ client: client as never });
    render(<EmailComposer onClose={vi.fn()} />);

    pickFromFiles([fileNode('n1', 'report.pdf', 1200)]);
    expect(await screen.findByText('report.pdf')).toBeInTheDocument();
    expect(screen.queryByTestId('fake-file-picker')).toBeNull();

    vi.useFakeTimers();
    fireEvent.change(screen.getByPlaceholderText(/subject/i), { target: { value: 'The report' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    expect(client.createDraft).toHaveBeenCalledTimes(1);
    expect(client.createDraft.mock.calls[0][8]).toEqual([
      expect.objectContaining({ blobId: 'blob-n1', name: 'report.pdf', type: 'application/pdf', size: 1200 }),
    ]);
    vi.useRealTimers();
  });

  it('leaves out a file a plugin refuses', async () => {
    hoisted.beforeAttachmentUpload.mockImplementation(async (info) => info.name !== 'setup.exe');
    useAuthStore.setState({ client: filesClient() as never });
    render(<EmailComposer onClose={vi.fn()} />);

    pickFromFiles([fileNode('n1', 'setup.exe', 10), fileNode('n2', 'notes.pdf', 10)]);
    expect(await screen.findByText('notes.pdf')).toBeInTheDocument();
    expect(screen.queryByText('setup.exe')).toBeNull();
  });

  it('stops at the per-message size limit and says so', async () => {
    useAuthStore.setState({ client: filesClient({ getMaxSizeAttachmentsPerEmail: () => 1500 }) as never });
    render(<EmailComposer onClose={vi.fn()} />);

    pickFromFiles([fileNode('n1', 'small.pdf', 1000), fileNode('n2', 'big.pdf', 1000)]);
    expect(await screen.findByText('small.pdf')).toBeInTheDocument();
    expect(screen.queryByText('big.pdf')).toBeNull();
    expect(hoisted.toastError).toHaveBeenCalledWith('attachments_total_too_large');
  });
});
