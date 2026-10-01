import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';

// The real composer around the real editor and its "@" recipient list: the
// two share the keyboard, and the composer handles Escape (close) and
// Ctrl+Enter (send) in the capture phase, before the editor sees them.

vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));

// ─── Composer dependency mocks (as in composer-close-guard.test.tsx) ──────────

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
    recipientMentionsEnabled: true,
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
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

const DRAFT = {
  to: 'Bob Builder <bob@example.com>, carol.smith@example.com',
  cc: '',
  bcc: 'Geheim <geheim@example.com>',
  subject: 'Half-written',
  body: '<p>Hallo</p>',
  showCc: false,
  showBcc: true,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

/** Lets the suggestion's async item lookup finish. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Lets the editor's delayed focus (and scroll to the cursor) run inside the test. */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

async function renderComposer() {
  const onClose = vi.fn();
  render(<EmailComposer initialData={DRAFT} onClose={onClose} />);
  // An edit makes the draft dirty, so closing asks first instead of closing.
  fireEvent.change(screen.getByDisplayValue('Half-written'), { target: { value: 'Half-written more' } });
  // TipTap keeps its editor on the editable element.
  const dom = await waitFor(() => {
    const el = document.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
    expect(el?.editor).toBeTruthy();
    return el!;
  });
  const editor = dom.editor!;
  // A new message focuses the To field 100ms after opening. Let that happen
  // first: arriving later, it would blur the editor and close the list.
  const to = within(screen.getByTestId('composer-to')).getByRole('combobox');
  await waitFor(() => expect(document.activeElement).toBe(to));
  act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 1); });
  return { editor, onClose };
}

async function typeInto(editor: Editor, text: string) {
  act(() => { editor.view.dispatch(editor.state.tr.insertText(text)); });
  await settle();
}

const press = (editor: Editor, key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(editor.view.dom, { key, ...init });

const mentionList = () => screen.queryByRole('listbox', { name: 'mention_recipients' });

describe('composer with the @ recipient list', () => {
  // jsdom has no layout. After an insertion the editor focuses a frame later
  // and ProseMirror measures a Range to scroll the cursor into view.
  const range = Range.prototype as unknown as Record<string, unknown>;
  beforeAll(() => {
    range.getClientRects = () => [];
    range.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 });
  });
  afterAll(() => {
    delete range.getClientRects;
    delete range.getBoundingClientRect;
  });

  it('lists To recipients only - never Bcc', async () => {
    const { editor } = await renderComposer();
    await typeInto(editor, ' @');
    const options = within(await screen.findByRole('listbox', { name: 'mention_recipients' })).getAllByRole('option');
    // What will be inserted first, then the full name where it differs.
    expect(options.map((o) => o.textContent)).toEqual(['@BobBob Builder · bob@example.com', '@Carolcarol.smith@example.com']);
  });

  it('points screen readers from the editor at the list and the highlighted name', async () => {
    const { editor } = await renderComposer();
    await typeInto(editor, ' @');
    const list = await screen.findByRole('listbox', { name: 'mention_recipients' });
    const options = within(list).getAllByRole('option');
    const dom = editor.view.dom;
    expect(dom.getAttribute('aria-autocomplete')).toBe('list');
    expect(dom.getAttribute('aria-controls')).toBe(list.id);
    expect(dom.getAttribute('aria-activedescendant')).toBe(options[0].id);

    press(editor, 'ArrowDown');
    await waitFor(() => expect(dom.getAttribute('aria-activedescendant')).toBe(options[1].id));

    press(editor, 'Escape');
    await waitFor(() => expect(mentionList()).toBeNull());
    expect(dom.hasAttribute('aria-controls')).toBe(false);
    expect(dom.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('offers nothing when mentions are turned off in the settings', async () => {
    useSettingsStore.setState({ recipientMentionsEnabled: false });
    try {
      const { editor } = await renderComposer();
      await typeInto(editor, ' @');
      expect(mentionList()).toBeNull();
    } finally {
      useSettingsStore.setState({ recipientMentionsEnabled: true });
    }
  });

  it('lets Escape close the open list, not the composer; the next Escape asks to close', async () => {
    const { editor, onClose } = await renderComposer();
    await typeInto(editor, ' @');
    await screen.findByRole('listbox', { name: 'mention_recipients' });

    press(editor, 'Escape');
    await waitFor(() => expect(mentionList()).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    press(editor, 'Escape');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('close_draft_title');
  });

  it('keeps Ctrl+Enter as the send shortcut while the list is open', async () => {
    const { editor } = await renderComposer();
    await typeInto(editor, ' @');
    await screen.findByRole('listbox', { name: 'mention_recipients' });
    // The composer takes it first; the editor then leaves it alone - no
    // recipient picked, no line break.
    expect(press(editor, 'Enter', { ctrlKey: true })).toBe(false);
    expect(editor.getText()).toBe('Hallo @');
  });

  it('picks with the arrows and Enter, or with Tab, instead of breaking the line', async () => {
    const { editor } = await renderComposer();
    await typeInto(editor, ' @');
    await screen.findByRole('listbox', { name: 'mention_recipients' });
    press(editor, 'ArrowDown');
    press(editor, 'Enter');
    await nextFrame();
    expect(editor.getText()).toBe('Hallo @Carol ');

    await typeInto(editor, '@b');
    await screen.findByRole('listbox', { name: 'mention_recipients' });
    press(editor, 'Tab');
    await nextFrame();
    expect(editor.getText()).toBe('Hallo @Carol @Bob ');
    expect(editor.state.doc.childCount).toBe(1);
    expect(mentionList()).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('closes the list when the focus moves to another field, which gets Escape back', async () => {
    const { editor } = await renderComposer();
    act(() => { editor.view.focus(); });
    expect(document.activeElement).toBe(editor.view.dom);
    await typeInto(editor, ' @');
    await screen.findByRole('listbox', { name: 'mention_recipients' });

    // Shift+Tab, say: the subject field takes the focus.
    const subject = screen.getByDisplayValue('Half-written more');
    act(() => { subject.focus(); });
    await waitFor(() => expect(mentionList()).toBeNull());

    fireEvent.keyDown(subject, { key: 'Escape' });
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('close_draft_title');
  });

  it('closes the list on a click elsewhere, but not on a click on the list itself', async () => {
    const { editor } = await renderComposer();
    await typeInto(editor, ' @');
    const list = await screen.findByRole('listbox', { name: 'mention_recipients' });

    // Its scrollbar or padding: the editor keeps the focus, the list stays.
    expect(fireEvent.mouseDown(list)).toBe(false);
    fireEvent.pointerDown(list);
    expect(mentionList()).not.toBeNull();

    fireEvent.pointerDown(screen.getByDisplayValue('Half-written more'));
    await waitFor(() => expect(mentionList()).toBeNull());
  });

  it('inserts a clicked recipient', async () => {
    const { editor } = await renderComposer();
    await typeInto(editor, ' @');
    const list = await screen.findByRole('listbox', { name: 'mention_recipients' });
    fireEvent.mouseDown(within(list).getAllByRole('option')[0]);
    await nextFrame();
    expect(editor.getText()).toBe('Hallo @Bob ');
    await waitFor(() => expect(mentionList()).toBeNull());
  });
});
