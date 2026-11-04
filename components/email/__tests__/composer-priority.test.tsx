import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

// #970: the priority picked in the Options menu goes out with the message and
// with every draft save, and a re-opened draft comes back with it.

// ─── Heavy component mocks (mirrors composer-close-guard.test.tsx) ──────────

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
  sanitizeSignatureHtmlForDisplay: (v: string) => v,
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
  subject: 'Plans',
  body: '<p>Hello</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

const openOptions = () => {
  if (!screen.queryByTestId('composer-priority')) fireEvent.click(screen.getByTestId('composer-options-menu'));
};
const pick = (level: 'high' | 'normal' | 'low') => {
  openOptions();
  fireEvent.click(screen.getByTestId(`composer-priority-${level}`));
};
const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;

async function send(onSend: ReturnType<typeof vi.fn>) {
  fireEvent.click(sendButton());
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0] as { priority?: string };
}

function mockClient() {
  const createDraft = vi.fn().mockResolvedValue('draft-8');
  useAuthStore.setState({
    client: {
      createDraft,
      getEmail: vi.fn().mockResolvedValue({ id: 'draft-8', attachments: [] }),
      hasDelayedSend: () => false,
      getMaxDelayedSend: () => 0,
    } as never,
    activeAccountId: 'acct-A' as never,
  });
  return createDraft;
}

async function saveViaCloseDialog(requestCloseRef: React.MutableRefObject<((afterClose?: () => void) => void) | null>) {
  // Closing saves the draft; no question unless the save fails.
  act(() => requestCloseRef.current!(vi.fn()));
}

describe('composer message priority (#970)', () => {
  afterEach(() => {
    useAuthStore.setState({ client: null, activeAccountId: null });
    vi.clearAllMocks();
  });

  it('offers high / normal / low in the Options menu with normal selected', () => {
    render(<EmailComposer initialData={DRAFT} />);
    openOptions();
    expect(screen.getByTestId('composer-priority-normal')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('composer-priority-high')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('composer-priority-low')).toHaveAttribute('aria-checked', 'false');
  });

  it.each(['high', 'low'] as const)('sends with %s priority after picking it', async (level) => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
    pick(level);
    expect(screen.getByTestId(`composer-priority-${level}`)).toHaveAttribute('aria-checked', 'true');
    expect((await send(onSend)).priority).toBe(level);
  });

  it('sends no priority when it stays normal', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
    expect((await send(onSend)).priority).toBeUndefined();
  });

  it('saves the draft with the picked priority', async () => {
    const createDraft = mockClient();
    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    render(<EmailComposer initialData={DRAFT} requestCloseRef={requestCloseRef} onClose={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('Plans'), { target: { value: 'Plans, edited' } });
    pick('high');

    await saveViaCloseDialog(requestCloseRef);
    await waitFor(() => expect(createDraft).toHaveBeenCalled());
    expect(createDraft.mock.calls[0][13]).toEqual({ priority: 'high' });
  });

  it('counts a priority change alone as an unsaved edit of a re-opened draft', async () => {
    const createDraft = mockClient();
    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    render(<EmailComposer initialData={{ ...DRAFT, draftId: 'draft-7', priority: 'high' }} requestCloseRef={requestCloseRef} onClose={vi.fn()} />);
    pick('low');

    await saveViaCloseDialog(requestCloseRef);
    await waitFor(() => expect(createDraft).toHaveBeenCalled());
    expect(createDraft.mock.calls[0][13]).toEqual({ priority: 'low' });
  });

  it('restores the priority of a re-opened draft and sends it again', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT, priority: 'low' }} onSend={onSend} />);
    openOptions();
    expect(screen.getByTestId('composer-priority-low')).toHaveAttribute('aria-checked', 'true');
    expect((await send(onSend)).priority).toBe('low');
  });

  it('keeps the priority when the composer is stashed on unmount', () => {
    const onSaveState = vi.fn();
    const { unmount } = render(<EmailComposer initialData={DRAFT} onSaveState={onSaveState} />);
    pick('high');
    unmount();
    expect(onSaveState).toHaveBeenCalledTimes(1);
    expect(onSaveState.mock.calls[0][0]).toMatchObject({ priority: 'high' });
  });
});
