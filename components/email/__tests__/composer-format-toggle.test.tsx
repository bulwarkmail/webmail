import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';
import { SIGNATURE_BLOCK_MARKER } from '../signature-block';

// ─── Heavy component mocks (mirrors composer-reopened-draft-signature.test.tsx) ─

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
    identities: [
      { id: 'id-me', email: 'me@example.com', name: 'Me', htmlSignature: '<b>Alice</b>', textSignature: 'Alice' },
    ] as Array<Record<string, unknown>>,
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
    // The default position: replies/forwards get the signature appended at
    // send time rather than embedded above the quote.
    signaturePosition: 'below_quote',
    signatureNewMailEnabled: true,
    signatureReplyForwardEnabled: true,
    signatureSeparatorEnabled: true,
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
  sanitizeSignatureHtmlForDisplay: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  sanitizePluginBodyHtml: (v: string) => v,
  escapeHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
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
 * #1022: the HTML / plain-text choice used to live only in settings. The
 * composer toolbar now carries a per-message toggle. Switching converts the
 * body in place and keeps the signature invariant (exactly one copy, in the
 * target format) that the send path relies on.
 */

const DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Hello',
  body: '<p>Draft <b>text</b></p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

// The plain-text switch lives in the toolbar's Options menu; open it on demand.
const toggle = () => {
  if (!screen.queryByTestId('composer-format-toggle')) fireEvent.click(screen.getByTestId('composer-options-menu'));
  return screen.getByTestId('composer-format-toggle') as HTMLButtonElement;
};
const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;
const textarea = () => document.querySelector('textarea') as HTMLTextAreaElement | null;
const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

async function send(onSend: ReturnType<typeof vi.fn>) {
  fireEvent.click(sendButton());
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0] as { body: string; htmlBody?: string };
}

describe('composer HTML / plain-text toggle (#1022)', () => {
  afterEach(() => {
    useSettingsStore.setState({ plainTextMode: false });
    vi.clearAllMocks();
  });

  it('starts in the rich-text editor and switches to a plain-text textarea', () => {
    render(<EmailComposer initialData={DRAFT} />);
    expect(screen.getByTestId('rich-text-editor')).toBeInTheDocument();
    expect(textarea()).toBeNull();
    expect(toggle()).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle());

    expect(screen.queryByTestId('rich-text-editor')).not.toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    // Formatting flattened, signature carried over as plain text - once.
    expect(textarea()!.value).toBe('Draft text\n\n-- \nAlice');
  });

  it('sends text/plain only after switching, with exactly one signature', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
    fireEvent.click(toggle());

    const sent = await send(onSend);
    expect(sent.htmlBody).toBeUndefined();
    expect(sent.body).toBe('Draft text\n\n-- \nAlice');
    expect(countOf(sent.body, 'Alice')).toBe(1);
  });

  it('switches back to HTML and sends an embedded signature exactly once', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
    fireEvent.click(toggle());
    fireEvent.change(textarea()!, { target: { value: 'Edited\n\nSecond\n\n-- \nAlice' } });
    fireEvent.click(toggle());

    expect(screen.getByTestId('rich-text-editor')).toBeInTheDocument();
    expect(textarea()).toBeNull();

    const sent = await send(onSend);
    expect(sent.htmlBody).toContain('<p>Edited</p><p>Second</p>');
    expect(countOf(sent.htmlBody!, SIGNATURE_BLOCK_MARKER)).toBe(1);
    expect(countOf(sent.htmlBody!, '<b>Alice</b>')).toBe(1);
    expect(countOf(sent.body, 'Alice')).toBe(1);
  });

  it('honours the "plain text only" setting as the default and still lets the user switch', () => {
    useSettingsStore.setState({ plainTextMode: true });
    render(<EmailComposer initialData={{ ...DRAFT, body: 'Plain draft' }} />);
    expect(textarea()).not.toBeNull();
    expect(toggle()).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle());
    expect(screen.getByTestId('rich-text-editor')).toBeInTheDocument();
  });

  it('re-opens a draft in the format it was written in', () => {
    render(<EmailComposer initialData={{ ...DRAFT, body: 'Plain draft', plainTextMode: true }} />);
    expect(textarea()).not.toBeNull();
    expect(textarea()!.value).toContain('Plain draft');
  });

  it('stashes the chosen format with the draft on unmount', () => {
    const onSaveState = vi.fn();
    const { unmount } = render(<EmailComposer initialData={DRAFT} onSaveState={onSaveState} />);
    fireEvent.click(toggle());
    fireEvent.change(textarea()!, { target: { value: 'changed' } });
    unmount();
    expect(onSaveState).toHaveBeenCalledTimes(1);
    expect(onSaveState.mock.calls[0][0]).toMatchObject({ plainTextMode: true, body: 'changed' });
  });
});
