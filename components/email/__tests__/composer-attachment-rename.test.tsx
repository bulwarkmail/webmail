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
  useToastStore: { getState: () => ({ toasts: [] }) },
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
 * Renaming an attachment chip: the new name goes into the draft and the sent
 * message, and survives the re-resolution of draft parts after each save.
 * The extension can't be changed.
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

/** A server that lists each saved version's part under the name it was saved with. */
function mockClient(createDraft = vi.fn().mockResolvedValueOnce('draft-v2').mockResolvedValueOnce('draft-v3')) {
  const getEmail = vi.fn().mockImplementation(async (id: string) => {
    const call = createDraft.mock.calls.length - 1;
    const saved = (createDraft.mock.calls[call]?.[8] ?? []) as { name: string }[];
    return {
      id,
      attachments: saved.map((part) => ({ partId: '2', blobId: `part-blob-of-${id}`, name: part.name, type: 'application/pdf', size: 1234 })),
    };
  });
  useAuthStore.setState({ client: { createDraft, getEmail, hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never });
  return { createDraft, getEmail };
}

async function renameChip(from: string, stem: string) {
  const chip = screen.getByText(from).closest('.rounded-md') as HTMLElement;
  fireEvent.click(within(chip).getByTestId('composer-rename'));
  const input = screen.getByRole('textbox', { name: 'rename_title' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: stem } });
  fireEvent.click(screen.getByRole('button', { name: 'rename' }));
}

describe('renaming an attachment in the composer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({ client: null });
    vi.clearAllMocks();
  });

  it('edits the name without its extension and updates the chip', async () => {
    mockClient();
    render(<EmailComposer initialData={REOPENED_DRAFT} onClose={vi.fn()} />);

    const chip = screen.getByText('report.pdf').closest('.rounded-md') as HTMLElement;
    fireEvent.click(within(chip).getByTestId('composer-rename'));
    const input = screen.getByRole('textbox', { name: 'rename_title' }) as HTMLInputElement;
    expect(input.value).toBe('report');
    expect(screen.getByTestId('prompt-suffix')).toHaveTextContent('.pdf');

    // A path separator can't go into a file name.
    fireEvent.change(input, { target: { value: 'Q3/report' } });
    expect(screen.getByRole('alert')).toHaveTextContent('rename_invalid_chars');
    expect(screen.getByRole('button', { name: 'rename' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'x'.repeat(252) } });
    expect(screen.getByRole('alert')).toHaveTextContent('rename_too_long');

    fireEvent.change(input, { target: { value: 'Q3 report' } });
    fireEvent.click(screen.getByRole('button', { name: 'rename' }));
    expect(screen.getByText('Q3 report.pdf')).toBeInTheDocument();
    expect(screen.queryByText('report.pdf')).toBeNull();
  });

  it('saves the new name in the draft, and keeps it after the parts are re-resolved', async () => {
    const { createDraft } = mockClient();
    render(<EmailComposer initialData={REOPENED_DRAFT} onClose={vi.fn()} />);

    // The rename alone is an edit worth saving.
    await renameChip('report.pdf', 'Q3 report');
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][8]).toEqual([
      expect.objectContaining({ blobId: 'part-blob-v1', name: 'Q3 report.pdf', type: 'application/pdf' }),
    ]);

    // The next save points at the new version's part, under the new name.
    fireEvent.change(screen.getByDisplayValue('Quarterly numbers'), { target: { value: 'Quarterly numbers v2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(createDraft.mock.calls[1][8]).toEqual([
      expect.objectContaining({ blobId: 'part-blob-of-draft-v2', name: 'Q3 report.pdf' }),
    ]);
    expect(screen.getByText('Q3 report.pdf')).toBeInTheDocument();
  });

  it('re-resolves a part renamed while its save was running', async () => {
    let finishFirstSave: (id: string) => void = () => {};
    const createDraft = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishFirstSave = resolve; }))
      .mockResolvedValueOnce('draft-v3');
    mockClient(createDraft);
    render(<EmailComposer initialData={REOPENED_DRAFT} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('Quarterly numbers'), { target: { value: 'Quarterly numbers v2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(createDraft).toHaveBeenCalledTimes(1);

    await renameChip('report.pdf', 'renamed');
    await act(async () => {
      finishFirstSave('draft-v2');
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

    // The first version's part died with it: the rename goes out with the new one.
    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(createDraft.mock.calls[1][8]).toEqual([
      expect.objectContaining({ blobId: 'part-blob-of-draft-v2', name: 'renamed.pdf' }),
    ]);
  });

  it('sends the new name', async () => {
    mockClient();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<EmailComposer initialData={REOPENED_DRAFT} onSend={onSend} />);

    await renameChip('report.pdf', 'Final report');
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({ name: 'Final report.pdf', type: 'application/pdf' }),
    ]);
  });

  it('leaves the draft alone when the name stays the same', async () => {
    const { createDraft } = mockClient();
    render(<EmailComposer initialData={REOPENED_DRAFT} onClose={vi.fn()} />);

    await renameChip('report.pdf', 'report');
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('has a right-click menu on the chip in a browser', async () => {
    mockClient();
    render(<EmailComposer initialData={REOPENED_DRAFT} onClose={vi.fn()} />);

    const chip = screen.getByText('report.pdf').closest('.rounded-md') as HTMLElement;
    fireEvent.contextMenu(chip, { clientX: 5, clientY: 5 });
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    const labels = items.map((item) => item.querySelector('[data-menu-label]')?.textContent);
    expect(labels).toEqual(['preview', 'rename_menu', 'recipient_remove']);

    fireEvent.click(items[1]);
    expect((screen.getByRole('textbox', { name: 'rename_title' }) as HTMLInputElement).value).toBe('report');
  });

  it('starts an unnamed attachment from the name it is shown with', async () => {
    mockClient();
    render(<EmailComposer initialData={{ ...REOPENED_DRAFT, attachments: [{ ...REOPENED_DRAFT.attachments[0], name: '' }] }} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('composer-rename'));
    expect((screen.getByRole('textbox', { name: 'rename_title' }) as HTMLInputElement).value).toBe('Document');
    expect(screen.getByTestId('prompt-suffix')).toHaveTextContent('.pdf');
  });
});
