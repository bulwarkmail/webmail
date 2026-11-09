// The composer's end of the desktop app's Edit, on the real composer.
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { resetEditSessions, useEditSessions } from '@/lib/desktop/edit-attachments';
import { useAuthStore } from '@/stores/auth-store';

// ─── Heavy component mocks (mirrors reply-addressing.test.tsx) ────────────────

const editorKeyDown = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/offline/availability', async (original) => ({
  ...(await original<typeof import('@/lib/offline/availability')>()),
  scopeDecided: () => true,
}));

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', {
    'data-testid': 'rich-text-editor',
    onKeyDown: (event: React.KeyboardEvent) => {
      if (!event.defaultPrevented) editorKeyDown();
    },
  }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
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

const updateSetting = vi.fn();

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
    updateSetting: (...args: unknown[]) => updateSetting(...args),
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
  toast: { info: () => {}, error: toastError, success: () => {} },
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
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

// Discard used to share the X button's path: without unsaved changes it just
// closed, so a draft reopened via "Cancel and edit" stayed in Drafts.

const REOPENED_DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Lunch',
  body: '<p>Hello there</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: 'draft-1',
};

const session = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'a.txt', type: 'text/plain', account: 'acct', source: '{"kind":"draft","draftId":"draft-1"}',
  changed: false, version: 0, hash: 'h', claimed: false, held: false, savedAs: false, lastChance: false, ...over,
});

function fakeEdit() {
  return {
    canEdit: () => true,
    begin: vi.fn(),
    open: vi.fn(),
    reopen: vi.fn(),
    list: vi.fn(async () => useEditSessions.getState().sessions),
    settle: vi.fn(async () => useEditSessions.getState().sessions),
    read: vi.fn(),
    taken: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    discard: vi.fn(async () => ({ held: [] })),
    forceDiscard: vi.fn(async () => ({ held: [] })),
    askClear: vi.fn(async () => true),
    clear: vi.fn(async () => ({ held: [] })),
    wipe: vi.fn(async () => ({ held: [] })),
    shown: vi.fn(),
    setSource: vi.fn(),
    claim: vi.fn(),
    onChange: vi.fn(() => () => {}),
  };
}

const DRAFT_WITH_FILE = { ...REOPENED_DRAFT, attachments: [{ blobId: 'b1', name: 'a.txt', type: 'text/plain', size: 3 }] };

describe('the composer with a file open for editing', () => {
  let edit: ReturnType<typeof fakeEdit>;

  beforeEach(() => {
    edit = fakeEdit();
    window.bulwarkDesktop = { version: 1, platform: 'win32', edit, dialogs: { confirm: vi.fn(async () => 0) } } as never;
    resetEditSessions();
    useAuthStore.setState({ activeAccountId: 'acct' } as never);
  });

  afterEach(() => {
    window.bulwarkDesktop = undefined;
    useAuthStore.setState({ activeAccountId: null } as never);
  });

  it('a double click on Send, while it looks at the file, sends once', async () => {
    useEditSessions.setState({ sessions: [session({ changed: true })] });
    // Both clicks wait on the same answer, so both would go on.
    let answer: (value: unknown) => void = () => {};
    const looking = new Promise((resolve) => { answer = resolve; });
    edit.settle.mockImplementation(() => looking as never);
    const onSend = vi.fn(async () => {});
    render(<EmailComposer initialData={DRAFT_WITH_FILE} onSend={onSend as never} onClose={vi.fn()} />);
    await screen.findAllByTestId('composer-edit-update');

    const send = screen.getAllByTestId('composer-send')[0];
    fireEvent.click(send);
    fireEvent.click(send);
    await act(async () => { answer([session({ changed: true })]); });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(onSend).toHaveBeenCalledTimes(1);
    // One question, too: each click would otherwise put up its own.
    expect((window.bulwarkDesktop as unknown as { dialogs: { confirm: ReturnType<typeof vi.fn> } }).dialogs.confirm).toHaveBeenCalledTimes(1);
  });

  it('with nothing open for editing, Send looks at nothing', async () => {
    const onSend = vi.fn(async () => {});
    render(<EmailComposer initialData={REOPENED_DRAFT} onSend={onSend as never} onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(edit.settle).not.toHaveBeenCalled();
  });

  const forward = (phishingMarked: boolean) => (
    <EmailComposer
      mode="forward"
      replyTo={{ subject: 'Original', phishingMarked, attachments: [{ blobId: 'b1', name: 'a.txt', type: 'text/plain', size: 3 }] }}
      onClose={vi.fn()}
    />
  );

  it('a part forwarded from an ordinary message has Edit', async () => {
    render(forward(false));
    expect(await screen.findByTestId('composer-edit')).toBeTruthy();
  });

  it('a part forwarded from a message marked as phishing has none', async () => {
    render(forward(true));
    await screen.findByText('a.txt');
    expect(screen.queryByTestId('composer-edit')).toBeNull();
  });

  it('the mark stays on the part through a hand-over to another window', async () => {
    render(<EmailComposer initialData={{ ...REOPENED_DRAFT, draftId: null, attachments: [{ blobId: 'b1', name: 'a.txt', type: 'text/plain', size: 3, editBlocked: true }] }} onClose={vi.fn()} />);
    await screen.findByText('a.txt');
    expect(screen.queryByTestId('composer-edit')).toBeNull();
  });
});
