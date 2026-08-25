import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

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
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
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

/**
 * A host that replaces the compose session - a mailto: click, say - must not
 * drop text the user has not sent. It hands a follow-up to requestCloseRef and
 * the composer runs it only once it has really closed, so "Save" and "Discard"
 * continue into the new session while "Cancel" leaves the draft standing.
 */

const DIRTY_DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Half-written',
  body: '<p>Still typing</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

function renderWithCloseRef(props: Record<string, unknown> = {}) {
  const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
  const afterClose = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <EmailComposer
      initialData={DIRTY_DRAFT}
      requestCloseRef={requestCloseRef}
      onClose={onClose}
      {...props}
    />,
  );
  // Typing is what makes the draft dirty; initialData alone is the baseline.
  fireEvent.change(screen.getByDisplayValue('Half-written'), {
    target: { value: 'Half-written more' },
  });
  return { requestCloseRef, afterClose, onClose, unmount: view.unmount };
}

describe('composer close guard with a follow-up', () => {
  it('asks before replacing an unsaved draft instead of dropping it', async () => {
    const { requestCloseRef, afterClose } = renderWithCloseRef();

    act(() => requestCloseRef.current!(afterClose));

    expect(await screen.findByText('close_draft_title')).toBeInTheDocument();
    expect(afterClose).not.toHaveBeenCalled();
  });

  it('runs the follow-up after discarding', async () => {
    const { requestCloseRef, afterClose, onClose } = renderWithCloseRef();

    act(() => requestCloseRef.current!(afterClose));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('discard'));

    await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
    // The host's own close runs first, so the new session starts from a clean slate.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(afterClose.mock.invocationCallOrder[0]);
  });

  it('drops the follow-up when the user cancels', async () => {
    const { requestCloseRef, afterClose, onClose } = renderWithCloseRef();

    act(() => requestCloseRef.current!(afterClose));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('cancel'));

    expect(afterClose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // A later, unrelated close must not resurrect the abandoned follow-up.
    act(() => requestCloseRef.current!());
    const reopened = await screen.findByRole('alertdialog');
    fireEvent.click(within(reopened).getByText('discard'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(afterClose).not.toHaveBeenCalled();
  });

  it('closes straight through when there is nothing to lose', async () => {
    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    const afterClose = vi.fn();
    render(<EmailComposer requestCloseRef={requestCloseRef} onClose={vi.fn()} />);

    act(() => requestCloseRef.current!(afterClose));

    await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('close_draft_title')).not.toBeInTheDocument();
  });

  it('runs the follow-up after saving the draft', async () => {
    const { requestCloseRef, afterClose } = renderWithCloseRef();

    act(() => requestCloseRef.current!(afterClose));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('save'));

    await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
  });

  it('drops the follow-up when the save fails and the rescue takes over', async () => {
    // When the server refuses the draft, the composer text survives only via
    // the unmount stash into the continue-draft slot (#702). That rescue
    // outranks the request that triggered the close, so the follow-up must
    // never fire - otherwise the new session would bury the stashed text.
    const createDraft = vi.fn().mockRejectedValue(new Error('server refused'));
    useAuthStore.setState({
      client: { createDraft, hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const onSaveState = vi.fn();
      const { requestCloseRef, afterClose, onClose, unmount } = renderWithCloseRef({ onSaveState });

      act(() => requestCloseRef.current!(afterClose));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByText('save'));

      // The host still gets its close - the composer must not stay stuck -
      // but the follow-up is dropped because the text was never persisted.
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(createDraft).toHaveBeenCalled();
      expect(afterClose).not.toHaveBeenCalled();

      // The rescue itself: unmounting stashes the live text on the host.
      unmount();
      expect(onSaveState).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Half-written more' }),
      );
    } finally {
      useAuthStore.setState({ client: null });
      consoleError.mockRestore();
    }
  });
});
