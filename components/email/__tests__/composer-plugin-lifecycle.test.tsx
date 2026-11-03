import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { useState } from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { emailHooks, clearAllHooks } from '@/lib/plugin-hooks';
import { resetComposerSessions } from '@/lib/plugin-composer-hooks';

// mail-compose hooks fired by the composer itself: onComposerOpen and
// onComposerClose once per session (not per remount), onDraftAutoSave after a
// save the server took, and the onBeforeCompose prefill the host hands in.
// The hook module is the real one here.

// ─── Heavy component mocks (mirrors reply-addressing.test.tsx) ────────────────

const editorKeyDown = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

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

const DRAFT = {
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
  draftId: null,
};

const flushCloseTimer = () => act(() => new Promise((r) => setTimeout(r, 10)));

const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;

function Host({ onSend, sessionKey = 's1' }: { onSend?: () => Promise<void>; sessionKey?: string }) {
  const [open, setOpen] = useState(true);
  if (!open) return <p>closed</p>;
  return (
    <EmailComposer
      sessionKey={sessionKey}
      requestCloseRef={requestCloseRef}
      initialData={DRAFT}
      onClose={() => setOpen(false)}
      onSend={async () => {
        setOpen(false);
        await onSend?.();
      }}
    />
  );
}

beforeEach(() => {
  clearAllHooks();
  resetComposerSessions();
  useAuthStore.setState({ client: null });
});

describe('onComposerOpen / onComposerClose', () => {
  it('reports the open with the mode and the original message', () => {
    const opened = vi.fn();
    emailHooks.onComposerOpen.register('test', opened);
    render(
      <EmailComposer
        mode="reply"
        sessionKey="r1"
        sourceEmailId="orig-1"
        replyTo={{ from: [{ email: 'alice@example.com' }], subject: 'Plans' }}
      />,
    );
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith({ mode: 'reply', inReplyToId: 'orig-1', originalSubject: 'Plans' });
  });

  it('treats a remount with the same session as the same composer', async () => {
    const opened = vi.fn();
    const closed = vi.fn();
    emailHooks.onComposerOpen.register('test', opened);
    emailHooks.onComposerClose.register('test', closed);

    const { rerender } = render(<div key="a"><EmailComposer sessionKey="same" initialData={DRAFT} /></div>);
    // Moved to another parent: React mounts a new composer.
    rerender(<section key="b"><EmailComposer sessionKey="same" initialData={DRAFT} /></section>);
    await flushCloseTimer();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
  });

  it('reports a close without a send', async () => {
    const closed = vi.fn();
    emailHooks.onComposerClose.register('test', closed);
    render(<Host />);

    // Nothing typed: closes without asking.
    act(() => requestCloseRef.current!());
    await screen.findByText('closed');
    await flushCloseTimer();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith({ draftId: null, sent: false });
  });

  it('reports a close after a send as sent, even though the host closes mid-send', async () => {
    const closed = vi.fn();
    emailHooks.onComposerClose.register('test', closed);
    render(<Host onSend={() => new Promise((r) => setTimeout(r, 20))} />);

    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await screen.findByText('closed');
    await act(() => new Promise((r) => setTimeout(r, 50)));

    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ sent: true }));
  });
});

describe('onDraftAutoSave', () => {
  it('fires after the server took the draft, not when the save fails', async () => {
    const saved = vi.fn();
    emailHooks.onDraftAutoSave.register('test', saved);
    const createDraft = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue('draft-7');
    useAuthStore.setState({
      client: { createDraft, getEmail: vi.fn(), hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<EmailComposer initialData={DRAFT} />);
      fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'Lunch?' } });
      await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      await act(async () => {});
      expect(saved).not.toHaveBeenCalled();

      fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'Lunch on Friday?' } });
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(saved).toHaveBeenCalledWith({ draftId: 'draft-7', subject: 'Lunch on Friday?' });
    } finally {
      consoleError.mockRestore();
      useAuthStore.setState({ client: null });
    }
  }, 15_000);
});

describe('onBeforeCompose prefill', () => {
  it('fills the fields of a new message', () => {
    render(<EmailComposer prefill={{ to: ['carol@example.com'], subject: 'From a plugin' }} />);
    expect(screen.getByTestId('composer-subject')).toHaveValue('From a plugin');
    expect(screen.getByText('carol@example.com')).toBeInTheDocument();
  });

  it('goes over what the host handed in', () => {
    render(<EmailComposer initialData={DRAFT} prefill={{ subject: 'Changed' }} />);
    expect(screen.getByTestId('composer-subject')).toHaveValue('Changed');
    // Fields the plugin left alone stay.
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });
});

describe('onBeforeDraftAutoSave', () => {
  function withClient(createDraft: ReturnType<typeof vi.fn>) {
    useAuthStore.setState({
      client: { createDraft, getEmail: vi.fn(), hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never,
    });
  }

  it('lets a plugin skip a save while typing', async () => {
    const before = vi.fn().mockReturnValue(false);
    emailHooks.onBeforeDraftAutoSave.register('test', before);
    const createDraft = vi.fn().mockResolvedValue('draft-1');
    withClient(createDraft);
    try {
      render(<EmailComposer initialData={DRAFT} />);
      fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'Lunch?' } });
      await waitFor(() => expect(before).toHaveBeenCalled(), { timeout: 4000 });
      await act(async () => {});

      expect(createDraft).not.toHaveBeenCalled();
    } finally {
      useAuthStore.setState({ client: null });
    }
  }, 15_000);

  it('saves the draft a plugin returns', async () => {
    emailHooks.onBeforeDraftAutoSave.register('test', (draft: { subject: string }) => ({ ...draft, subject: `[x] ${draft.subject}` }));
    const createDraft = vi.fn().mockResolvedValue('draft-1');
    withClient(createDraft);
    try {
      render(<EmailComposer initialData={DRAFT} />);
      fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'Lunch?' } });
      await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });

      expect(createDraft.mock.calls[0][1]).toBe('[x] Lunch?');
    } finally {
      useAuthStore.setState({ client: null });
    }
  }, 15_000);
});
