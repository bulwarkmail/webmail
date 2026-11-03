import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { useAuthStore } from '@/stores/auth-store';
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
vi.mock('@/components/contacts/directory-picker-dialog', () => ({
  DirectoryPickerDialog: () => <div role="dialog" aria-label="directory"><input aria-label="directory search" /></div>,
}));
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

// What the address autocomplete finds: contacts, directory, recent recipients.
const addressBook = vi.hoisted(() => ({ entries: [] as Array<{ name: string; email: string; group?: unknown }> }));

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
    mentionAddsRecipientTo: 'to',
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
    // Matches anywhere, as the real one does.
    getAutocomplete: (query: string) => addressBook.entries.filter((e) =>
      `${e.name} ${e.email}`.toLowerCase().includes(query.toLowerCase())),
    getGroupMembers: () => [],
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

async function renderComposer(draft: Partial<typeof DRAFT> = {}) {
  const onClose = vi.fn();
  render(<EmailComposer initialData={{ ...DRAFT, ...draft }} onClose={onClose} />);
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
  // The user clicks into the body to place the caret. Without that, the
  // first focus counts as arriving by keyboard and moves it to the start.
  fireEvent.mouseDown(editor.view.dom);
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
  // and ProseMirror measures a Range to scroll the cursor into view, and a
  // mousedown in the body asks for the element under the pointer.
  const range = Range.prototype as unknown as Record<string, unknown>;
  const doc = document as unknown as Record<string, unknown>;
  beforeAll(() => {
    range.getClientRects = () => [];
    range.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 });
    doc.elementFromPoint = () => null;
  });
  afterAll(() => {
    delete range.getClientRects;
    delete range.getBoundingClientRect;
    delete doc.elementFromPoint;
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
  describe('with contacts', () => {
    beforeAll(() => {
      addressBook.entries = [
        { name: 'Dana Scully', email: 'dana@example.com' },
        // Already on the message: in To, and blind-copied.
        { name: 'Bob Builder', email: 'bob@example.com' },
        { name: 'Geheim', email: 'geheim@example.com' },
        { name: 'Devs', email: '', group: { id: 'g1', memberCount: 3 } },
      ];
    });
    afterAll(() => {
      addressBook.entries = [];
      useSettingsStore.setState({ mentionAddsRecipientTo: 'to' } as never);
    });

    const toField = () => screen.getByTestId('composer-to');

    it('offers a contact once something is typed, and adds the picked one to To', async () => {
      const { editor } = await renderComposer();
      await typeInto(editor, ' @');
      // A bare @ is about the recipients only.
      expect(within(await screen.findByRole('listbox', { name: 'mention_recipients' })).getAllByRole('option')).toHaveLength(2);
      await typeInto(editor, 'd');
      const options = within(await screen.findByRole('listbox', { name: 'mention_recipients' })).getAllByRole('option');
      expect(options.map((o) => o.textContent)).toEqual(['@DanaDana Scully · dana@example.com+ to']);
      expect(within(toField()).queryByText(/Dana/)).toBeNull();

      press(editor, 'Enter');
      await nextFrame();
      expect(editor.getText()).toBe('Hallo @Dana ');
      expect(within(toField()).getByText(/Dana Scully/)).toBeTruthy();
    });

    it('never offers someone in Bcc, or a contact group', async () => {
      const { editor } = await renderComposer();
      await typeInto(editor, ' @ge');
      expect(mentionList()).toBeNull();
      await typeInto(editor, ' @dev');
      expect(mentionList()).toBeNull();
    });

    it('adds the picked contact to Cc when the settings say so', async () => {
      useSettingsStore.setState({ mentionAddsRecipientTo: 'cc' } as never);
      const { editor } = await renderComposer();
      expect(screen.queryByText('cc_label')).toBeNull();
      await typeInto(editor, ' @da');
      const list = await screen.findByRole('listbox', { name: 'mention_recipients' });
      expect(within(list).getByRole('option')).toHaveTextContent('+ cc');
      press(editor, 'Tab');
      await nextFrame();
      const ccRow = (await screen.findByText('cc_label')).parentElement!;
      expect(within(ccRow).getByText(/Dana Scully/)).toBeTruthy();
      expect(within(toField()).queryByText(/Dana/)).toBeNull();
    });

    it('offers recipients only when contacts are turned off', async () => {
      useSettingsStore.setState({ mentionAddsRecipientTo: 'off' } as never);
      const { editor } = await renderComposer();
      await typeInto(editor, ' @da');
      expect(mentionList()).toBeNull();
      await typeInto(editor, ' @b');
      expect(await screen.findByRole('listbox', { name: 'mention_recipients' })).toBeTruthy();
    });
  });
  describe('mention chips', () => {
    beforeAll(() => { addressBook.entries = [{ name: 'Dana Scully', email: 'dana@example.com' }]; });
    afterAll(() => { addressBook.entries = []; });

    const chipPos = (editor: Editor, email: string) => {
      let at = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'mentionChip' && node.attrs.email === email) at = pos;
      });
      return at;
    };
    const card = () => screen.queryByTestId('mention-card');

    it('shows who a picked mention is when it is clicked, and removes it from there', async () => {
      const { editor } = await renderComposer();
      await typeInto(editor, ' @b');
      await screen.findByRole('listbox', { name: 'mention_recipients' });
      press(editor, 'Enter');
      await nextFrame();
      const chip = editor.view.dom.querySelector('a.mention')!;
      expect(chip.textContent).toBe('@Bob');
      expect(chip.classList.contains('mention-outside')).toBe(false);

      act(() => { editor.commands.setNodeSelection(chipPos(editor, 'bob@example.com')); });
      const shown = await screen.findByTestId('mention-card');
      expect(shown).toHaveTextContent('Bob Builder');
      expect(shown).toHaveTextContent('bob@example.com');
      expect(shown).toHaveTextContent('action_copy');
      expect(shown).not.toHaveTextContent('mention_card_not_recipient');
      expect(within(shown).queryByRole('button', { name: 'mention_card_add' })).toBeNull();

      fireEvent.click(within(shown).getByRole('button', { name: 'mention_card_remove' }));
      await waitFor(() => expect(card()).toBeNull());
      expect(editor.view.dom.querySelector('a.mention')).toBeNull();
      expect(editor.getText()).toBe('Hallo ');
    });

    it('waits for a click: hovering a chip opens nothing, selecting it does', async () => {
      const { editor } = await renderComposer({ body: '<p>Hallo <a href="mailto:bob@example.com">@Bob</a></p>' });
      const chip = editor.view.dom.querySelector('a.mention')!;
      fireEvent.mouseOver(chip);
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));
      expect(card()).toBeNull();

      act(() => { editor.commands.setNodeSelection(chipPos(editor, 'bob@example.com')); });
      expect(await screen.findByTestId('mention-card')).toHaveTextContent('Bob Builder');
      // Moving the cursor off the chip closes it.
      act(() => { editor.commands.setTextSelection(1); });
      await waitFor(() => expect(card()).toBeNull());
    });

    it('marks a mention of someone not on the message and offers to add them', async () => {
      const { editor } = await renderComposer({ body: '<p>Hallo <a href="mailto:dana@example.com">@Dana</a></p>' });
      const chip = () => editor.view.dom.querySelector('a.mention')!;
      expect(chip().classList.contains('mention-outside')).toBe(true);
      expect(within(screen.getByTestId('composer-to')).queryByText(/dana/)).toBeNull();

      act(() => { editor.commands.setNodeSelection(chipPos(editor, 'dana@example.com')); });
      const shown = await screen.findByTestId('mention-card');
      expect(shown).toHaveTextContent('Dana Scully');
      expect(shown).toHaveTextContent('mention_card_not_recipient');
      fireEvent.click(within(shown).getByRole('button', { name: 'mention_card_add' }));

      // Added with the name from the contacts, not just the address.
      expect(within(screen.getByTestId('composer-to')).getByText(/Dana Scully/)).toBeTruthy();
      await waitFor(() => expect(chip().classList.contains('mention-outside')).toBe(false));
      expect(card()).not.toHaveTextContent('mention_card_not_recipient');
    });
  });

  // The Insert link dialog portals to the body but sits inside the composer
  // in React's tree, so its keys bubble through the composer's handler.
  it('lets Escape in the Insert link dialog close only that dialog, not the composer', async () => {
    const { onClose } = await renderComposer();
    fireEvent.click(screen.getByTitle('link'));
    const dialog = await screen.findByRole('dialog', { name: 'insert_link' });
    fireEvent.keyDown(dialog.querySelector('input')!, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  // The directory picker is drawn inside the composer itself, not portaled.
  it('lets Escape in the directory picker leave the composer alone', async () => {
    // Every other capability answers nothing.
    const client = new Proxy({ supportsPrincipals: () => true }, {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
    });
    useAuthStore.setState({ client: client as never });
    try {
      const { onClose } = await renderComposer();
      fireEvent.click(screen.getByTestId('composer-directory-picker'));
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'directory search' }), { key: 'Escape' });
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      useAuthStore.setState({ client: null });
    }
  });
});
