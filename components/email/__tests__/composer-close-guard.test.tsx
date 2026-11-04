import { PaneIdContext } from '@/hooks/use-pane-context';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { LIVE_REGION_IDS, resetAnnouncerForTests } from '@/lib/announce';

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

const draftToast = vi.hoisted(() => ({ showDraftSavedToast: vi.fn() }));
vi.mock('@/lib/compose/draft-close-toast', () => draftToast);

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
  escapeHtml: (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
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

describe('a message row dragged over the composer', () => {
  const rowDrag = { types: ['application/x-email-ids', 'text/plain'], files: [], getData: () => 'Subject of the row', dropEffect: '' };
  const subjectField = () => screen.getByDisplayValue('Half-written');
  const draft = {
    to: '', cc: '', bcc: '', subject: 'Half-written', body: '', showCc: false, showBcc: false,
    selectedIdentityId: 'id-me', subAddressTag: '', mode: 'compose' as const, draftId: null,
  };

  it('is stopped in the standard shell, or Subject would take the row\'s subject', () => {
    render(<EmailComposer initialData={draft} onClose={vi.fn()} />);
    // fireEvent returns false when the event's default was prevented.
    expect(fireEvent.dragOver(subjectField(), { dataTransfer: rowDrag })).toBe(false);
    expect(fireEvent.drop(subjectField(), { dataTransfer: rowDrag })).toBe(false);
  });

  it('is left to the shell inside a Pro pane', () => {
    render(
      <PaneIdContext.Provider value="main">
        <EmailComposer initialData={draft} onClose={vi.fn()} />
      </PaneIdContext.Provider>,
    );
    expect(fireEvent.dragOver(subjectField(), { dataTransfer: rowDrag })).toBe(true);
    expect(fireEvent.drop(subjectField(), { dataTransfer: rowDrag })).toBe(true);
  });
});

/**
 * A host that replaces the compose session - a mailto: click, say - must not
 * drop text the user has not sent. It hands a follow-up to requestCloseRef and
 * the composer runs it only once it has really closed. Closing saves the draft
 * without asking; only a failed save asks, and there "Discard" continues into
 * the new session while "Cancel" leaves the draft standing.
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

beforeEach(resetAnnouncerForTests);

describe('composer close guard with a follow-up', () => {
  const savingClient = (createDraft = vi.fn().mockResolvedValue('draft-9')) => {
    useAuthStore.setState({
      client: { createDraft, getEmail: vi.fn(), hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never,
    });
    return createDraft;
  };
  afterEach(() => {
    useAuthStore.setState({ client: null });
  });

  it('saves the draft and runs the follow-up, without asking', async () => {
    const createDraft = savingClient();
    const { requestCloseRef, afterClose, onClose } = renderWithCloseRef();

    act(() => requestCloseRef.current!(afterClose));

    await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks only when the save fails, and keeps the text', async () => {
    // No connection to save through: the save fails.
    const { requestCloseRef, afterClose, onClose } = renderWithCloseRef();

    act(() => requestCloseRef.current!(afterClose));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('save_failed_close');
    expect(within(dialog).getByRole('button', { name: /try_again/ })).toBeInTheDocument();
    expect(afterClose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Half-written more')).toBeInTheDocument();
  });

  describe('in the desktop app', () => {
    afterEach(() => {
      window.bulwarkDesktop = undefined;
    });

    const nativeBridge = (answer: number) => {
      const confirm = vi.fn(async () => answer);
      window.bulwarkDesktop = { version: 1, platform: 'win32', dialogs: { confirm } } as never;
      return confirm;
    };

    it('asks through the OS when the save fails, and shows no dialog of its own', async () => {
      const confirm = nativeBridge(2);
      const { requestCloseRef, afterClose, onClose } = renderWithCloseRef();
      act(() => requestCloseRef.current!(afterClose));
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(confirm.mock.calls[0]).toMatchObject([{ message: 'close_draft_title', detail: 'save_failed_close', buttons: ['try_again', 'discard', 'cancel'], defaultId: 0 }]);
      expect(screen.queryByText('close_draft_title')).not.toBeInTheDocument();
      // The last button is Cancel: nothing happens.
      await act(async () => {});
      expect(onClose).not.toHaveBeenCalled();
      expect(afterClose).not.toHaveBeenCalled();
    });

    it('Discard discards, and the follow-up runs', async () => {
      nativeBridge(1);
      const { requestCloseRef, afterClose, onClose } = renderWithCloseRef();
      act(() => requestCloseRef.current!(afterClose));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
    });

    it('saves without asking when the save works', async () => {
      const confirm = nativeBridge(2);
      savingClient();
      const { requestCloseRef, afterClose } = renderWithCloseRef();
      act(() => requestCloseRef.current!(afterClose));
      await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it('runs the follow-up after discarding a draft that could not be saved', async () => {
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

  it('closes without saving again once autosave has stored every change', async () => {
    const createDraft = savingClient();
    const { requestCloseRef, afterClose } = renderWithCloseRef();
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await act(async () => {});

    act(() => requestCloseRef.current!(afterClose));

    await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('close_draft_title')).not.toBeInTheDocument();
  });

  it('saves the edits made since the last autosave when it closes', async () => {
    const createDraft = savingClient();
    const { requestCloseRef, afterClose } = renderWithCloseRef();
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
    fireEvent.change(screen.getByDisplayValue('Half-written more'), { target: { value: 'Half-written more and more' } });

    act(() => requestCloseRef.current!(afterClose));

    await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(createDraft.mock.calls[1][1]).toBe('Half-written more and more');
    expect(screen.queryByText('close_draft_title')).not.toBeInTheDocument();
  });

  it('says the draft was kept, with a Discard that deletes it through the host', async () => {
    savingClient();
    draftToast.showDraftSavedToast.mockClear();
    const onDiscardDraft = vi.fn();
    const { requestCloseRef, afterClose } = renderWithCloseRef({ onDiscardDraft });

    act(() => requestCloseRef.current!(afterClose));

    await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
    expect(draftToast.showDraftSavedToast).toHaveBeenCalledTimes(1);
    const [discard, labels] = draftToast.showDraftSavedToast.mock.calls[0];
    expect(labels).toMatchObject({ saved: 'draft_saved', discard: 'discard' });
    discard();
    expect(onDiscardDraft).toHaveBeenCalledWith('draft-9', expect.anything());
  });

  // compose-19: the keys people bring from other mail apps.
  it('saves the draft on Ctrl+S, and keeps the browser from saving the page', async () => {
    const createDraft = savingClient();
    renderWithCloseRef();
    const subject = screen.getByDisplayValue('Half-written more');
    expect(fireEvent.keyDown(subject, { key: 's', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
  });

  it('shows Cc on Ctrl+Shift+C and Bcc on Ctrl+Shift+B, and puts the cursor there', async () => {
    renderWithCloseRef();
    const subject = screen.getByDisplayValue('Half-written more');
    expect(fireEvent.keyDown(subject, { key: 'C', ctrlKey: true, shiftKey: true })).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'cc_label' })));
    expect(fireEvent.keyDown(subject, { key: 'B', ctrlKey: true, shiftKey: true })).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'bcc_label' })));
  });

  it('closes straight through when there is nothing to lose', async () => {
    draftToast.showDraftSavedToast.mockClear();
    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    const afterClose = vi.fn();
    render(<EmailComposer requestCloseRef={requestCloseRef} onClose={vi.fn()} />);

    act(() => requestCloseRef.current!(afterClose));

    await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('close_draft_title')).not.toBeInTheDocument();
    expect(draftToast.showDraftSavedToast).not.toHaveBeenCalled();
  });

  it('tells screen readers the draft was saved when the user closes, not on autosave', async () => {
    const createDraft = savingClient();
    const polite = () => document.getElementById(LIVE_REGION_IDS.polite);
    const { requestCloseRef, afterClose } = renderWithCloseRef();
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(polite()?.textContent ?? '').not.toContain('draft_saved');

    fireEvent.change(screen.getByDisplayValue('Half-written more'), { target: { value: 'Half-written more and more' } });
    act(() => requestCloseRef.current!(afterClose));

    await waitFor(() => expect(polite()?.textContent).toContain('draft_saved'));
  });

  it('keeps the composer open, says why and drops the follow-up when the save fails', async () => {
    // A refused save keeps the live composer recoverable. Replacing it via a
    // close follow-up would bury the unsaved text. Navigation can still stash
    // that text through the existing unmount path.
    const createDraft = savingClient(vi.fn().mockRejectedValue(new Error('server refused')));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const onSaveState = vi.fn();
      const { requestCloseRef, afterClose, onClose, unmount } = renderWithCloseRef({ onSaveState });

      act(() => requestCloseRef.current!(afterClose));

      await waitFor(() => expect(createDraft).toHaveBeenCalled());
      expect(await screen.findByRole('alertdialog')).toHaveTextContent('save_failed_close');
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue('Half-written more')).toBeInTheDocument();
      expect(afterClose).not.toHaveBeenCalled();

      // The rescue itself: unmounting stashes the live text on the host.
      unmount();
      expect(onSaveState).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Half-written more' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
