import { render, act, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';

// ─── Heavy component mocks (mirrors reply-addressing.test.tsx) ────────────────

const toastError = vi.hoisted(() => vi.fn());

const editorFocus = vi.hoisted(() => vi.fn());
const caret = vi.hoisted(() => ({ textEnd: null as number | null, selected: [] as number[], focused: 0 }));

// Reports a stub editor as ready, the way the real one does once mounted.
vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ onEditorReady }: { onEditorReady?: (editor: unknown) => void }) => {
    React.useEffect(() => {
      const chain = {
        setTextSelection: (pos: number) => { caret.selected.push(pos); return chain; },
        focus: () => { caret.focused += 1; return chain; },
        run: () => true,
      };
      onEditorReady?.({ commands: { focus: editorFocus, setContent: () => {} }, isDestroyed: false, isEditable: true, state: {}, chain: () => chain, on: () => {}, off: () => {} });
    }, [onEditorReady]);
    return React.createElement('div', { 'data-testid': 'rich-text-editor' });
  },
}));

vi.mock('@/components/email/reply-quote-collapse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/email/reply-quote-collapse')>()),
  userTextEnd: () => caret.textEnd,
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

// A reply opened with nothing focused, so typing right away went nowhere.

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
  draftId: null,
};

describe('composer initial focus', () => {
  beforeEach(() => {
    editorFocus.mockClear();
    useSettingsStore.setState({ plainTextMode: false });
  });

  it('puts the caret at the start of a reply body', () => {
    render(<EmailComposer initialData={{ ...DATA, mode: 'reply' }} mode="reply" />);
    expect(editorFocus).toHaveBeenCalledTimes(1);
    expect(editorFocus).toHaveBeenCalledWith('start');
  });

  it('leaves a new, unaddressed message to focus the To field', () => {
    render(<EmailComposer initialData={{ ...DATA, to: '', mode: 'compose' }} mode="compose" />);
    expect(editorFocus).not.toHaveBeenCalled();
  });

  // desktop-p3-12: a new message that arrives addressed (a mail link) starts in the body, as in Outlook.
  it('puts the caret in the body of a new message that arrives addressed', () => {
    render(<EmailComposer initialData={{ ...DATA, mode: 'compose' }} mode="compose" />);
    expect(editorFocus).toHaveBeenCalledWith('start');
  });

  it('focuses the plain text body of a reply', async () => {
    useSettingsStore.setState({ plainTextMode: true });
    render(<EmailComposer initialData={{ ...DATA, mode: 'replyAll' }} mode="replyAll" />);
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
  });
});

// compose-p2-9: the white space under the text is the message too.
describe('a click in the empty space under the text', () => {
  beforeEach(() => {
    editorFocus.mockClear();
    caret.textEnd = null;
    caret.selected = [];
    caret.focused = 0;
    useSettingsStore.setState({ plainTextMode: false });
  });

  const emptySpace = () => screen.getByTestId('rich-text-editor').parentElement!.parentElement!;

  it('puts the caret at the end of the text above the folded quote', () => {
    caret.textEnd = 7;
    render(<EmailComposer initialData={{ ...DATA, mode: 'reply' }} mode="reply" />);
    editorFocus.mockClear();
    const event = fireEvent.mouseDown(emptySpace(), { button: 0 });
    expect(event).toBe(false);
    expect(caret.selected).toEqual([7]);
    expect(caret.focused).toBe(1);
  });

  it('puts the caret at the end of the body when nothing is folded', () => {
    render(<EmailComposer initialData={{ ...DATA, mode: 'compose' }} mode="compose" />);
    fireEvent.mouseDown(emptySpace(), { button: 0 });
    expect(editorFocus).toHaveBeenCalledWith('end');
  });

  it('leaves clicks on buttons alone', () => {
    caret.textEnd = 7;
    render(<EmailComposer initialData={{ ...DATA, mode: 'reply' }} mode="reply" />);
    const button = document.createElement('button');
    emptySpace().appendChild(button);
    fireEvent.mouseDown(button, { button: 0 });
    expect(caret.selected).toEqual([]);
  });
});
