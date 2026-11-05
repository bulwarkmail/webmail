import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// ─── Heavy component mocks (mirrors reply-addressing.test.tsx) ────────────────

const editorKeyDown = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const discardWithUndo = vi.hoisted(() => vi.fn());
vi.mock('@/lib/compose/draft-close-toast', () => ({ discardWithUndo, showDraftSavedToast: vi.fn() }));

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

describe('composer Discard button', () => {
  beforeEach(() => {
    discardWithUndo.mockClear();
    toastError.mockClear();
    updateSetting.mockClear();
    editorKeyDown.mockClear();
  });

  // compose-p2-10: no question; "Draft discarded" with Undo, as the toast's Discard.
  it('closes at once and deletes a reopened draft once Undo is over', () => {
    const onDiscardDraft = vi.fn();
    const onClose = vi.fn();
    render(<EmailComposer initialData={REOPENED_DRAFT} onDiscardDraft={onDiscardDraft} onClose={onClose} />);

    fireEvent.click(screen.getByText('discard'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(discardWithUndo).toHaveBeenCalledTimes(1);
    const [commit, labels] = discardWithUndo.mock.calls[0];
    expect(labels).toEqual({ discarded: 'draft_discarded', undo: 'undo' });
    // Not before the Undo time is over.
    expect(onDiscardDraft).not.toHaveBeenCalled();
    commit();
    expect(onDiscardDraft).toHaveBeenCalledWith('draft-1', { accountId: undefined, localAccountId: undefined });
  });

  it('brings the text back on Undo, and deletes nothing', () => {
    const onDiscardDraft = vi.fn();
    const onRestoreDiscarded = vi.fn();
    render(<EmailComposer initialData={REOPENED_DRAFT} onDiscardDraft={onDiscardDraft} onRestoreDiscarded={onRestoreDiscarded} onClose={() => {}} />);

    fireEvent.click(screen.getByText('discard'));
    const restore = discardWithUndo.mock.calls[0][2] as () => void;
    restore();

    expect(onRestoreDiscarded).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Lunch', draftId: 'draft-1', to: 'bob@example.com' }));
    expect(onDiscardDraft).not.toHaveBeenCalled();
  });

  // compose-p3-2: the host hides the draft (its reply card) while Undo is offered.
  it('tells the host which draft it is discarding before it closes', () => {
    const calls: string[] = [];
    const onDiscardStarted = vi.fn(() => calls.push('started'));
    render(<EmailComposer initialData={REOPENED_DRAFT} onDiscardStarted={onDiscardStarted} onClose={() => calls.push('closed')} />);

    fireEvent.click(screen.getByText('discard'));

    expect(onDiscardStarted).toHaveBeenCalledWith('draft-1');
    expect(calls).toEqual(['started', 'closed']);
  });

  it('has the main window say it for a composer in its own window', () => {
    const onDraftDiscarded = vi.fn();
    const onDiscardDraft = vi.fn();
    render(<EmailComposer initialData={REOPENED_DRAFT} onDiscardDraft={onDiscardDraft} ownWindow={{ onDraftDiscarded }} onClose={() => {}} />);

    fireEvent.click(screen.getByText('discard'));

    expect(onDraftDiscarded).toHaveBeenCalledWith('draft-1', { accountId: undefined, localAccountId: undefined });
    expect(discardWithUndo).not.toHaveBeenCalled();
    expect(onDiscardDraft).not.toHaveBeenCalled();
  });

  it('closes an empty, never saved composer without asking', () => {
    const onDiscardDraft = vi.fn();
    const onClose = vi.fn();
    render(<EmailComposer initialData={{ ...REOPENED_DRAFT, to: '', subject: '', body: '', draftId: null }} onDiscardDraft={onDiscardDraft} onClose={onClose} />);

    fireEvent.click(screen.getByText('discard'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onDiscardDraft).not.toHaveBeenCalled();
  });
});
