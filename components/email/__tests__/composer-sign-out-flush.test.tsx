import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { EmailComposer, type ComposerDraftData } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { flushComposers, resetComposeFlushRegistry } from '@/lib/compose-flush-registry';

// ─── Heavy component mocks (mirrors reply-addressing.test.tsx) ────────────────

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

/**
 * Before an automatic sign-out (organisation idle timeout or maximum session
 * length) every composer saves what the server doesn't have yet, through the
 * compose flush registry.
 */

const DRAFT: ComposerDraftData = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Half-written',
  body: '<p>Still typing</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose',
  draftId: null,
};

let createDraft: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetComposeFlushRegistry();
  createDraft = vi.fn().mockResolvedValue('draft-1');
  useAuthStore.setState({
    client: { createDraft, getEmail: vi.fn(), hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never,
  });
});

afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('composer flush before an automatic sign-out', () => {
  it('saves edits the autosave has not stored yet', async () => {
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('Half-written'), { target: { value: 'Half-written more' } });

    let result: Awaited<ReturnType<typeof flushComposers>> | undefined;
    await act(async () => { result = await flushComposers(5000); });

    expect(result).toEqual({ total: 1, settled: 1, failed: 0, timedOut: false });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][1]).toBe('Half-written more');
  });

  it('leaves a composer without changes alone', async () => {
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    await act(async () => { await flushComposers(5000); });

    expect(createDraft).not.toHaveBeenCalled();
  });

  it('saves a minimised composer opened again with its stashed edits', async () => {
    render(<EmailComposer initialData={{ ...DRAFT, unsaved: true }} onClose={vi.fn()} />);

    await act(async () => { await flushComposers(5000); });

    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][1]).toBe('Half-written');
  });

  it('asks before closing a composer opened with stashed edits', async () => {
    const onClose = vi.fn();
    const requestCloseRef: { current: ((afterClose?: () => void) => void) | null } = { current: null };
    render(<EmailComposer initialData={{ ...DRAFT, unsaved: true }} onClose={onClose} requestCloseRef={requestCloseRef} />);

    act(() => requestCloseRef.current?.());

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes a composer opened with text the server already has without asking', () => {
    const onClose = vi.fn();
    const requestCloseRef: { current: ((afterClose?: () => void) => void) | null } = { current: null };
    render(<EmailComposer initialData={{ ...DRAFT, draftId: 'draft-0', unsaved: false }} onClose={onClose} requestCloseRef={requestCloseRef} />);

    act(() => requestCloseRef.current?.());

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it('autosaves a composer opened with stashed edits', async () => {
    render(<EmailComposer initialData={{ ...DRAFT, unsaved: true }} onClose={vi.fn()} />);

    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(createDraft.mock.calls[0][1]).toBe('Half-written');
  });

  it('hands nothing back for stashed edits it did not change: the host has them', () => {
    const onSaveState = vi.fn();
    const view = render(<EmailComposer initialData={{ ...DRAFT, unsaved: true }} onClose={vi.fn()} onSaveState={onSaveState} />);
    view.unmount();

    expect(onSaveState).not.toHaveBeenCalled();
  });

  it('hands back the draft id an autosave of stashed edits got', async () => {
    const onSaveState = vi.fn();
    const view = render(<EmailComposer initialData={{ ...DRAFT, unsaved: true }} onClose={vi.fn()} onSaveState={onSaveState} />);
    await act(async () => { await flushComposers(5000); });
    view.unmount();

    expect(onSaveState).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft-1', unsaved: false }));
  });

  it('waits for a send in flight and saves no draft of the sent message', async () => {
    let finishSend!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => { finishSend = resolve; }));
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} onSend={onSend} />);
    fireEvent.change(screen.getByDisplayValue('Half-written'), { target: { value: 'Half-written more' } });
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const savesBeforeSignOut = createDraft.mock.calls.length;

    let done = false;
    const flushed = flushComposers(5000).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);

    await act(async () => { finishSend(); });
    await expect(flushed).resolves.toMatchObject({ total: 1, failed: 0, timedOut: false });
    expect(createDraft).toHaveBeenCalledTimes(savesBeforeSignOut);
  });

  it('reports a save the server refused, so the login page can say so', async () => {
    createDraft.mockRejectedValue(new Error('refused'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
      fireEvent.change(screen.getByDisplayValue('Half-written'), { target: { value: 'Half-written more' } });

      let result: Awaited<ReturnType<typeof flushComposers>> | undefined;
      await act(async () => { result = await flushComposers(5000); });
      expect(result).toMatchObject({ total: 1, failed: 1 });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('hands an already-saved state back as saved', async () => {
    const onSaveState = vi.fn();
    const view = render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} onSaveState={onSaveState} />);
    fireEvent.change(screen.getByDisplayValue('Half-written'), { target: { value: 'Half-written more' } });
    await act(async () => { await flushComposers(5000); });
    view.unmount();

    expect(onSaveState).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Half-written more', unsaved: false }));
  });

  it('marks the state it hands to the host on unmount as unsaved', () => {
    const onSaveState = vi.fn();
    const view = render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} onSaveState={onSaveState} />);
    fireEvent.change(screen.getByDisplayValue('Half-written'), { target: { value: 'Half-written more' } });
    view.unmount();

    expect(onSaveState).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Half-written more', unsaved: true }));
  });

  it('unregisters when it unmounts', async () => {
    const view = render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    view.unmount();

    await expect(flushComposers(1000)).resolves.toMatchObject({ total: 0 });
  });
});
