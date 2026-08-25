import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// ─── Heavy component mocks (mirrors reply-addressing.test.tsx) ────────────────

const editorKeyDown = vi.hoisted(() => vi.fn());

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', {
    'data-testid': 'rich-text-editor',
    onKeyDown: (event: React.KeyboardEvent) => {
      if (!event.defaultPrevented) editorKeyDown();
    },
  }),
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
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: () => {} },
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
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

/** A ready-to-send draft with everything but a subject. */
const DRAFT_WITHOUT_SUBJECT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: '',
  body: '<p>Hello there</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;

describe('composer empty subject warning', () => {
  beforeEach(() => {
    updateSetting.mockClear();
    editorKeyDown.mockClear();
  });

  it('keeps Send enabled when the subject is empty', () => {
    render(<EmailComposer initialData={DRAFT_WITHOUT_SUBJECT} />);
    expect(sendButton()).not.toBeDisabled();
  });

  it('asks for confirmation instead of sending', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITHOUT_SUBJECT} onSend={onSend} />);

    fireEvent.click(sendButton());

    expect(await screen.findByText('empty_subject.title')).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('intercepts Ctrl+Enter before the editor inserts a newline', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITHOUT_SUBJECT} onSend={onSend} />);

    fireEvent.keyDown(screen.getByTestId('rich-text-editor'), { key: 'Enter', ctrlKey: true });

    expect(await screen.findByText('empty_subject.title')).toBeInTheDocument();
    expect(editorKeyDown).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends with an empty subject once confirmed', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITHOUT_SUBJECT} onSend={onSend} />);

    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByText('empty_subject.send_anyway'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ subject: '', to: ['bob@example.com'] });
    expect(updateSetting).not.toHaveBeenCalled();
  });

  it('turns the warning off when "don\'t ask again" is checked', async () => {
    render(<EmailComposer initialData={DRAFT_WITHOUT_SUBJECT} onSend={vi.fn()} />);

    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByText('empty_subject.dont_ask_again'));
    fireEvent.click(screen.getByText('empty_subject.send_anyway'));

    await waitFor(() =>
      expect(updateSetting).toHaveBeenCalledWith('emptySubjectWarningEnabled', false)
    );
  });

  it('goes back to editing without sending', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITHOUT_SUBJECT} onSend={onSend} />);

    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByText('empty_subject.back'));

    await waitFor(() => expect(screen.queryByText('empty_subject.title')).not.toBeInTheDocument());
    expect(onSend).not.toHaveBeenCalled();
  });

  it('still sends normally when a subject is present', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT_WITHOUT_SUBJECT, subject: 'Lunch' }} onSend={onSend} />);

    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('empty_subject.title')).not.toBeInTheDocument();
  });
});
