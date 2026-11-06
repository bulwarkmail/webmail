import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// mail-p2-2: a reply docked under its message starts compact: no Subject
// line, no From line when there's only one address to send from, and the
// formatting bar folded behind its button. Full screen shows them again.
// inline-reply: no title row either. The kind of reply is a small menu at
// the start of the To row, and the window buttons and Close end that row.

// ─── Heavy component mocks (mirrors composer-mobile-formatting.test.tsx) ──────

const toastError = vi.hoisted(() => vi.fn());

// Shows whether the composer asked for the toolbar to be folded away.
vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ toolbarPlacement }: { toolbarPlacement?: string }) =>
    React.createElement('div', { 'data-testid': 'rich-text-editor', 'data-toolbar': toolbarPlacement ?? 'top' }),
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
    isSenderTrusted: () => false,
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
  escapeHtml: (v: string) => v,
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

const DATA = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Re: Lunch',
  body: '<p>Hello there</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'reply' as const,
  draftId: null,
};

const hidden = (el: Element | null) => !!el && el.className.split(/\s+/).includes('hidden');

describe('a reply docked under its message', () => {
  beforeEach(() => {
    toastError.mockClear();
    updateSetting.mockClear();
  });

  it('starts compact, with the formatting bar behind its button', () => {
    const { container } = render(<EmailComposer initialData={DATA} docked />);
    expect(hidden(container.querySelector('[data-composer-subject]'))).toBe(true);
    expect(hidden(container.querySelector('[data-composer-from]'))).toBe(true);
    const editor = screen.getByTestId('rich-text-editor');
    expect(editor).toHaveAttribute('data-toolbar', 'hidden');
    fireEvent.click(container.querySelector('[data-dock-formatting-toggle]')!);
    expect(editor).toHaveAttribute('data-toolbar', 'top');
  });

  it('shows everything in full screen', () => {
    const { container } = render(<EmailComposer initialData={DATA} docked />);
    fireEvent.click(screen.getByRole('button', { name: 'maximize' }));
    expect(hidden(container.querySelector('[data-composer-subject]'))).toBe(false);
    expect(screen.getByTestId('rich-text-editor')).toHaveAttribute('data-toolbar', 'top');
  });

  it('has no title row: the kind of reply, the window buttons and Close are in the To row', () => {
    const { container } = render(<EmailComposer initialData={DATA} docked />);
    expect(container.querySelector('[data-composer-header]')).toBeNull();
    const toRow = screen.getByTestId('composer-to');
    expect(within(toRow).getByTestId('composer-close')).toBeInTheDocument();
    expect(within(toRow).getByRole('button', { name: 'maximize' })).toBeInTheDocument();
    expect(within(toRow).getByTestId('composer-save-status')).toBeInTheDocument();
    // Full screen brings the title row back, and the To row is only To again.
    fireEvent.click(within(toRow).getByRole('button', { name: 'maximize' }));
    expect(container.querySelector('[data-composer-header]')).not.toBeNull();
    expect(within(screen.getByTestId('composer-to')).queryByTestId('composer-close')).toBeNull();
  });

  const ORIGINAL = {
    from: [{ email: 'bob@example.com', name: 'Bob' }],
    to: [{ email: 'me@example.com', name: 'Me' }],
    cc: [{ email: 'alice@example.com', name: 'Alice' }],
    subject: 'Lunch',
    body: 'Friday?',
    receivedAt: '2026-11-05T10:00:00Z',
  };
  const chips = () => [...document.querySelectorAll('[data-recipient-chip]')].map((el) => el.textContent ?? '');

  it('switches Reply all to Reply and back in place, keeping the text', () => {
    const onSwitchToForward = vi.fn();
    render(<EmailComposer mode="replyAll" replyTo={ORIGINAL} docked onSwitchToForward={onSwitchToForward} />);
    expect(chips().some((c) => c.includes('Alice'))).toBe(true);
    const menu = screen.getByTestId('composer-reply-type');
    expect(menu).toHaveAttribute('aria-label', 'reply_type');
    expect(menu).toHaveAttribute('data-reply-type', 'replyAll');

    fireEvent.click(menu);
    fireEvent.click(screen.getByTestId('composer-reply-type-reply'));
    expect(screen.getByTestId('composer-reply-type')).toHaveAttribute('data-reply-type', 'reply');
    expect(chips().some((c) => c.includes('Alice'))).toBe(false);
    expect(chips().some((c) => c.includes('Bob'))).toBe(true);

    fireEvent.click(screen.getByTestId('composer-reply-type'));
    fireEvent.click(screen.getByTestId('composer-reply-type-replyAll'));
    expect(chips().some((c) => c.includes('Alice'))).toBe(true);
    expect(chips().filter((c) => c.includes('Bob'))).toHaveLength(1);

    // Forward is the host's: it opens a forward of the same message.
    fireEvent.click(screen.getByTestId('composer-reply-type'));
    fireEvent.click(screen.getByTestId('composer-reply-type-forward'));
    expect(onSwitchToForward).toHaveBeenCalledTimes(1);
  });

  it('keeps From folded behind a button when there are several addresses to send from', async () => {
    const { useIdentityStore } = await import('@/stores/identity-store');
    const before = useIdentityStore.getState().identities;
    useIdentityStore.setState({ identities: [...before, { id: 'id-work', email: 'me@work.example', name: 'Me at work' }] } as never);
    try {
      const { container } = render(<EmailComposer initialData={DATA} docked />);
      const from = container.querySelector('[data-composer-from]');
      expect(hidden(from)).toBe(true);
      const button = screen.getByTestId('composer-dock-from');
      expect(button).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(button);
      expect(hidden(container.querySelector('[data-composer-from]'))).toBe(false);
    } finally {
      useIdentityStore.setState({ identities: before } as never);
    }
  });

  it('keeps every line when not docked', () => {
    const { container } = render(<EmailComposer initialData={DATA} />);
    expect(hidden(container.querySelector('[data-composer-subject]'))).toBe(false);
    expect(hidden(container.querySelector('[data-composer-from]'))).toBe(false);
  });
});
