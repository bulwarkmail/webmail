import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

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

  // compose-27: the subject and the attachment used to be two dialogs in a row.
  it('asks about a missing subject and a missing attachment in one dialog', async () => {
    useSettingsStore.setState({ attachmentReminderEnabled: true, attachmentReminderKeywords: ['hello'] } as never);
    try {
      const onSend = vi.fn();
      render(<EmailComposer initialData={DRAFT_WITHOUT_SUBJECT} onSend={onSend} />);

      fireEvent.click(sendButton());

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent('warnings_title');
      expect(dialog).toHaveTextContent('warning_subject');
      expect(dialog).toHaveTextContent('warning_attachment');
      // Several warnings: no "don't ask again", which would be unclear.
      expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();

      fireEvent.click(within(dialog).getByText('send_anyway'));

      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('forgot_attachment.title')).not.toBeInTheDocument();
    } finally {
      useSettingsStore.setState({ attachmentReminderEnabled: false, attachmentReminderKeywords: [] } as never);
    }
  });

  it('goes back to editing from the combined dialog without sending', async () => {
    useSettingsStore.setState({ attachmentReminderEnabled: true, attachmentReminderKeywords: ['hello'] } as never);
    try {
      const onSend = vi.fn();
      render(<EmailComposer initialData={DRAFT_WITHOUT_SUBJECT} onSend={onSend} />);

      fireEvent.click(sendButton());
      fireEvent.click(await screen.findByText('back'));

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      useSettingsStore.setState({ attachmentReminderEnabled: false, attachmentReminderKeywords: [] } as never);
    }
  });

  // compose-28: Send works with an empty body and asks first.
  it('keeps Send enabled with an empty body and asks "Send without text?"', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT_WITHOUT_SUBJECT, subject: 'Lunch?', body: '' }} onSend={onSend} />);
    expect(sendButton()).not.toBeDisabled();

    fireEvent.click(sendButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('empty_text_title');
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByText('send_anyway'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ subject: 'Lunch?' });
  });

  it('lists no subject and no text together', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT_WITHOUT_SUBJECT, body: '' }} onSend={onSend} />);

    fireEvent.click(sendButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('warning_subject');
    expect(dialog).toHaveTextContent('warning_text');
    expect(onSend).not.toHaveBeenCalled();
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

  // A draft saved with a "(No Subject)" placeholder came back with that as
  // its subject, so sending the resumed draft skipped the warning (#1189).
  it('saves a draft without a subject as an empty subject', async () => {
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

    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    render(
      <EmailComposer
        initialData={{ ...DRAFT_WITHOUT_SUBJECT, subject: 'Lunch' }}
        requestCloseRef={requestCloseRef}
        onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByDisplayValue('Lunch'), { target: { value: '' } });

    act(() => requestCloseRef.current!(vi.fn()));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('save'));

    await waitFor(() => expect(createDraft).toHaveBeenCalled());
    expect(createDraft.mock.calls[0][1]).toBe('');
    useAuthStore.setState({ client: null, activeAccountId: null });
  });
});
