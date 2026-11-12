import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const multi = vi.hoisted(() => ({ current: { enabled: false, groups: [] as unknown[], allIdentities: [] as unknown[] } }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => multi.current,
  stripCrossAccountIdentityPrefix: (id: string) => {
    const at = id.indexOf('::');
    return at < 0 ? { localAccountId: null, rawId: id } : { localAccountId: id.slice(0, at), rawId: id.slice(at + 2) };
  },
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
  return { useIdentityStore: hook, notifyIdentitySelected: () => {} };
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

// compose-24: the host closes the composer as soon as the send starts. A send
// that fails must still hand the message back, or it would vanish.


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

// A message is being written from an identity of another login than the
// active one (a reply to that login's mail, or From picked by hand). That
// login is signed out while the composer is open, so its identities leave
// the From list. The message must not leave from another login's address
// without the user choosing it: either nothing is sent and the composer says
// why, or the send still names the login the message was written for, so the
// host refuses it. (Harness of composer-send-refused.test.tsx.)
//
// Belongs in components/email/__tests__/.

const WORK = { id: 'login-work::b', email: 'me@work.example', name: 'Me at work' };
const HOME = { id: 'id-me', email: 'me@example.com', name: 'Me' };

const READY = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Re: Contract',
  body: '<p>Agreed.</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: WORK.id,
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;
const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the login of the From identity is signed out while the composer is open', () => {
  beforeEach(() => {
    multi.current = { enabled: true, groups: [], allIdentities: [HOME, WORK] };
  });

  it('control: while the login is there, the send names it', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<EmailComposer initialData={READY} onSend={onSend} />);
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ localAccountId: 'login-work', identityId: 'b', fromEmail: 'me@work.example' });
  });

  it('does not send the message from the remaining login’s address instead', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<EmailComposer initialData={READY} onSend={onSend} />);
    // The work login is gone: one login left, its identities only.
    await act(async () => {
      multi.current = { enabled: false, groups: [], allIdentities: [] };
      rerender(<EmailComposer initialData={READY} onSend={onSend} />);
    });
    fireEvent.click(sendButton());
    await settle(250);

    const sent = onSend.mock.calls.map((call) => call[0]);
    // Nothing sent, or a send that still names the work login (which the host refuses).
    for (const data of sent) {
      expect(data.localAccountId).toBe('login-work');
      expect(data.fromEmail).not.toBe('me@example.com');
    }
  });

  it('keeps showing the work address as From, and says its account is not connected', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<EmailComposer initialData={READY} onSend={onSend} />);
    await act(async () => {
      multi.current = { enabled: false, groups: [], allIdentities: [] };
      rerender(<EmailComposer initialData={READY} onSend={onSend} />);
    });

    const from = screen.getByTestId('composer-from') as HTMLSelectElement;
    expect(from.value).toBe(WORK.id);
    expect(from.selectedOptions[0]?.textContent).toContain('me@work.example');
    // Not one that can be picked again, and the other login's address is not put in its place.
    expect(from.selectedOptions[0]?.disabled).toBe(true);
    expect(screen.getByText('not_connected')).toBeTruthy();
  });

  it('sends from the address the user then picks by hand', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<EmailComposer initialData={READY} onSend={onSend} />);
    await act(async () => {
      multi.current = { enabled: false, groups: [], allIdentities: [] };
      rerender(<EmailComposer initialData={READY} onSend={onSend} />);
    });
    fireEvent.change(screen.getByTestId('composer-from'), { target: { value: HOME.id } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ identityId: 'id-me', fromEmail: 'me@example.com' });
    expect(screen.queryByText('not_connected')).toBeNull();
  });
});

// A composer belongs to the login it was opened in. Every send says so, also
// one from that login's own identity: the host then sends through that login
// or not at all, whichever login is the active one by the time Send is hit.
describe('the login a send names', () => {
  beforeEach(async () => {
    multi.current = { enabled: false, groups: [], allIdentities: [] };
    const { useAuthStore } = await import('@/stores/auth-store');
    (useAuthStore as unknown as { setState: (patch: object) => void }).setState({ activeAccountId: 'login-home' });
  });
  afterEach(async () => {
    const { useAuthStore } = await import('@/stores/auth-store');
    (useAuthStore as unknown as { setState: (patch: object) => void }).setState({ activeAccountId: null });
  });

  it('is the login the composer was opened in for one of its own identities', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<EmailComposer initialData={{ ...READY, selectedIdentityId: HOME.id }} onSend={onSend} />);
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ localAccountId: 'login-home', identityId: 'id-me', fromEmail: 'me@example.com' });
  });

  it('stays that login when another one becomes the active one before Send', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<EmailComposer initialData={{ ...READY, selectedIdentityId: HOME.id }} onSend={onSend} />);
    const { useAuthStore } = await import('@/stores/auth-store');
    await act(async () => {
      (useAuthStore as unknown as { setState: (patch: object) => void }).setState({ activeAccountId: 'login-other' });
      rerender(<EmailComposer initialData={{ ...READY, selectedIdentityId: HOME.id }} onSend={onSend} />);
    });
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ localAccountId: 'login-home', identityId: 'id-me' });
  });
});
