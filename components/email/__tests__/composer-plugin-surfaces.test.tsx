import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { checkActions, resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';
import { clearOffers, lastSlotProps, offerSlots, slotProps } from '@/components/plugins/__tests__/fake-plugin-offer';
import { useSettingsStore } from '@/stores/settings-store';
import { SLOT_CATALOG } from '@/lib/plugin-slot-catalog';
import { requestPanel, resetPanelRequests } from '@/lib/plugin-sandbox/panel-requests';

// Plugin surfaces of the composer: frames above and below the message text
// (fed the draft, at most every 2 seconds), and entries in the Send and
// Attach menus.

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}));
vi.mock('@/components/plugins/plugin-iframe-slot', async () => ({
  PluginIframeSlot: (await import('@/components/plugins/__tests__/fake-plugin-offer')).FakeIframeSlot,
}));

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
    updateSetting: () => {},
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
    onBeforeAttachmentUpload: { intercept: async () => true },
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

const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const draftOf = (el: HTMLElement) => slotProps(el).draft as { subject: string; to: string[]; htmlBody: string; identityId: string };

const dispatch = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  resetActions();
  dispatch.mockClear();
  setActionDispatcher(dispatch);
  useAuthStore.setState({ client: null });
});

afterEach(() => {
  clearOffers();
  setActionDispatcher(null);
  resetPanelRequests();
  vi.useRealTimers();
});

describe('composer-above-body and composer-below-body', () => {
  it('put the frames around the message text with the draft', () => {
    offerSlots('p1', ['composer-above-body', 'composer-below-body']);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    const above = screen.getByTestId('slot-composer-above-body');
    const below = screen.getByTestId('slot-composer-below-body');
    const editor = screen.getByTestId('rich-text-editor');
    expect(follows(screen.getByTestId('composer-subject'), above)).toBe(true);
    expect(follows(above, editor)).toBe(true);
    expect(follows(editor, below)).toBe(true);
    expect(draftOf(above)).toMatchObject({ subject: 'Lunch', to: ['bob@example.com'], htmlBody: '<p>Hello there</p>', identityId: 'id-me' });
    expect(draftOf(below).subject).toBe('Lunch');
  });

  it('send a changed draft only after 2 seconds without changes', () => {
    offerSlots('p1', ['composer-above-body']);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    vi.useFakeTimers();

    fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'Lunch?' } });
    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'Lunch at 12?' } });
    act(() => { vi.advanceTimersByTime(1900); });
    expect(draftOf(screen.getByTestId('slot-composer-above-body')).subject).toBe('Lunch');

    act(() => { vi.advanceTimersByTime(200); });
    expect(draftOf(screen.getByTestId('slot-composer-above-body')).subject).toBe('Lunch at 12?');
  });

  it('let a plugin read the selection and write over it', () => {
    useSettingsStore.setState({ plainTextMode: true });
    try {
      offerSlots('p1', ['composer-above-body']);
      const { container } = render(<EmailComposer initialData={{ ...DRAFT, body: 'Hello there' }} onClose={vi.fn()} />);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      const props = lastSlotProps('composer-above-body') as { insertText: (t: string) => boolean; getSelectedText: () => string };

      textarea.setSelectionRange(0, 5);
      expect(props.getSelectedText()).toBe('Hello');
      act(() => { expect(props.insertText('Hi')).toBe(true); });

      expect(textarea.value).toBe('Hi there');
      expect(props.insertText('x'.repeat(100_001))).toBe(false);
    } finally {
      useSettingsStore.setState({ plainTextMode: false });
    }
  });

  it('let a cloud picker put share links into the text', () => {
    offerSlots('p1', ['composer-attachment-source']);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    const props = lastSlotProps('composer-attachment-source');
    expect(typeof props.onAttach).toBe('function');
    expect(typeof props.insertText).toBe('function');
  });

  it('put the attachment source in the plugin button row, where the catalogue says it is', () => {
    offerSlots('p1', ['composer-attachment-source']);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    const frame = screen.getByTestId('slot-composer-attachment-source');
    expect(frame.closest('[data-composer-plugin-row]')).not.toBeNull();
    expect(SLOT_CATALOG['composer-attachment-source'].where).toMatch(/plugin row/);
  });

  it('draw nothing without a plugin', () => {
    const { container } = render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(container.querySelector('[data-plugin-slot="composer-above-body"]')).toBeNull();
    expect(container.querySelector('[data-plugin-slot="composer-below-body"]')).toBeNull();
  });
});

describe('composer-send-menu', () => {
  it('turns Send into a split button for plugin entries and sends the draft on click', async () => {
    act(() => setPluginActions('p', 'Later', 'composer-send-menu', [{ id: 'later', label: 'Send with Later' }]));
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    // The phone and the desktop Send button are both in the DOM.
    fireEvent.click(screen.getAllByRole('button', { name: 'more_actions' })[0]);
    expect(screen.queryByRole('menuitem', { name: /schedule_send/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getAllByRole('menuitem', { name: 'Send with Later' })[0]); });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [pluginId, surface, actionId, context] = dispatch.mock.calls[0];
    expect([pluginId, surface, actionId]).toEqual(['p', 'composer-send-menu', 'later']);
    expect((context as { draft: { subject: string } }).draft).toMatchObject({ subject: 'Lunch', to: ['bob@example.com'] });
    expect(screen.queryByRole('menuitem', { name: 'Send with Later' })).toBeNull();
  });

  it('lists the entries under Schedule send when the account has it', () => {
    useAuthStore.setState({
      client: { hasDelayedSend: () => true, getMaxDelayedSend: () => 30 * 86400, createDraft: vi.fn() } as never,
    });
    act(() => setPluginActions('p', 'Later', 'composer-send-menu', [{ id: 'later', label: 'Send with Later' }]));
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'schedule_send' })[0]);
    const schedule = screen.getAllByRole('menuitem', { name: /schedule_send/ })[0];
    const plugin = screen.getAllByRole('menuitem', { name: 'Send with Later' })[0];
    expect(follows(schedule, plugin)).toBe(true);
  });

  it('keeps a plain Send button without plugin entries or scheduled send', () => {
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'more_actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'schedule_send' })).toBeNull();
  });
});

describe('composer-options-menu and composer-toolbar-actions', () => {
  it('lists plugin options in Options, ticked ones as check items counted in the badge', async () => {
    act(() => setPluginActions('smime', 'S/MIME', 'composer-options-menu', [
      { id: 'sign', label: 'Sign', checked: true, description: 'With your certificate' },
      { id: 'encrypt', label: 'Encrypt', checked: false },
      { id: 'zones', label: 'Insert time in other zones' },
    ]));
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    const options = screen.getByTestId('composer-options-menu');
    expect(options).toHaveTextContent('1');
    fireEvent.click(options);
    const sign = screen.getByRole('menuitemcheckbox', { name: /Sign/ });
    expect(sign).toHaveAttribute('aria-checked', 'true');
    expect(sign).toHaveTextContent('With your certificate');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Encrypt' })).toHaveAttribute('aria-checked', 'false');

    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Encrypt' })); });
    expect(dispatch).toHaveBeenCalledWith('smime', 'composer-options-menu', 'encrypt', { composerId: expect.any(String) });
    // A check item leaves the menu open, so several options can be set.
    expect(screen.getByRole('menuitemcheckbox', { name: /Sign/ })).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Insert time in other zones' })); });
    expect(dispatch).toHaveBeenCalledWith('smime', 'composer-options-menu', 'zones', { composerId: expect.any(String) });
  });

  it('draws plugin buttons in the bottom bar like Attach, with the shortcut in the tooltip', async () => {
    act(() => setPluginActions('ai', 'Assistant', 'composer-toolbar-actions', [{ id: 'ask', label: 'Assistant', icon: 'sparkles', shortcut: 'Alt+A' }]));
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Assistant' });
    expect(button).toHaveAttribute('title', 'Assistant (Alt+A)');
    expect(button.className).toContain('h-9');
    // In the bar only when it is wide enough next to the app's own buttons...
    expect(button.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(button.className).toContain('@[44rem]/composer-bar:inline-flex');
    let bar: HTMLElement | null = button;
    while (bar && !bar.classList.contains('@container/composer-bar')) bar = bar.parentElement;
    expect(bar).not.toBeNull();
    // Not in the plugin frame row above the bar.
    expect(button.closest('[data-composer-plugin-row]')).toBeNull();
    await act(async () => { fireEvent.click(button); });
    expect(dispatch).toHaveBeenCalledWith('ai', 'composer-toolbar-actions', 'ask', { composerId: expect.any(String) });

    // ...and otherwise in the Options menu, which is shown only while narrow.
    dispatch.mockClear();
    fireEvent.click(screen.getByTestId('composer-options-menu'));
    const entry = screen.getByRole('menuitem', { name: 'Assistant' });
    expect(entry.closest('[data-narrow-only]')!.className).toContain('@[44rem]/composer-bar:hidden');
    await act(async () => { fireEvent.click(entry); });
    expect(dispatch).toHaveBeenCalledWith('ai', 'composer-toolbar-actions', 'ask', { composerId: expect.any(String) });
  });

  it('refuses odd values for checked and description', () => {
    expect(() => setPluginActions('p', 'P', 'composer-options-menu', checkActions([{ id: 'a', label: 'A', checked: 'yes' }]))).toThrow(/checked must be true or false/);
    expect(() => checkActions([{ id: 'a', label: 'A', description: 'x'.repeat(121) }])).toThrow(/description/);
  });
});

describe('composer-attach-menu', () => {
  it('turns Attach into a menu for plugin entries', async () => {
    act(() => setPluginActions('p', 'Cloud', 'composer-attach-menu', [{ id: 'cloud', label: 'From the cloud' }]));
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('composer-attach-menu'));
    expect(screen.getByRole('menuitem', { name: 'attach_from_device' })).toBeInTheDocument();
    expect(screen.queryByTestId('composer-attach-from-files')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'From the cloud' })); });

    expect(dispatch).toHaveBeenCalledWith('p', 'composer-attach-menu', 'cloud', { composerId: expect.any(String) });
    expect(screen.queryByRole('menuitem', { name: 'From the cloud' })).toBeNull();
  });

  it('keeps the plain Attach button without plugin entries', () => {
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(screen.queryByTestId('composer-attach-menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'attach' })).toBeInTheDocument();
  });
});

describe('composer-selection-menu', () => {
  const SURFACE = 'composer-selection-menu';
  const rightClick = (el: HTMLElement) => {
    const event = createEvent.contextMenu(el, { clientX: 40, clientY: 50 });
    fireEvent(el, event);
    return event;
  };

  beforeEach(() => { useSettingsStore.setState({ plainTextMode: true }); });
  afterEach(() => { useSettingsStore.setState({ plainTextMode: false }); });

  it('leaves the browser menu alone without plugin entries, and without a selection', () => {
    const { container } = render(<EmailComposer initialData={{ ...DRAFT, body: 'Hello there' }} onClose={vi.fn()} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 5);
    expect(rightClick(textarea).defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => { setPluginActions('p1', 'P1', SURFACE, checkActions([{ id: 'improve', label: 'Improve' }])); });
    textarea.setSelectionRange(3, 3);
    expect(rightClick(textarea).defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers Cut, Copy and the plugin entries on selected text, and hands the click the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      act(() => { setPluginActions('p1', 'P1', SURFACE, checkActions([{ id: 'improve', label: 'Improve', icon: 'sparkles' }])); });
      const { container } = render(<EmailComposer initialData={{ ...DRAFT, body: 'Hello there' }} onClose={vi.fn()} />);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      textarea.setSelectionRange(0, 5);

      expect(rightClick(textarea).defaultPrevented).toBe(true);
      const menu = screen.getByRole('menu');
      expect(menu).toHaveTextContent('cut');
      expect(menu).toHaveTextContent('copy');
      fireEvent.click(screen.getByRole('menuitem', { name: 'Improve' }));
      await act(async () => {});
      expect(dispatch).toHaveBeenCalledWith('p1', SURFACE, 'improve', expect.objectContaining({ selection: { text: 'Hello' } }));
      expect(typeof dispatch.mock.calls[0][3].composerId).toBe('string');
      expect(screen.queryByRole('menu')).toBeNull();

      textarea.setSelectionRange(0, 5);
      rightClick(textarea);
      fireEvent.click(screen.getByTestId('composer-selection-copy'));
      expect(writeText).toHaveBeenCalledWith('Hello');
      expect(textarea.value).toBe('Hello there');

      textarea.setSelectionRange(0, 6);
      rightClick(textarea);
      fireEvent.click(screen.getByTestId('composer-selection-cut'));
      expect(writeText).toHaveBeenLastCalledWith('Hello ');
      expect(textarea.value).toBe('there');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('composer-sidebar and composer-sidebar-right', () => {
  function stubWidth(width: number) {
    class FixedWidthObserver {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        if ((el as HTMLElement).dataset.testid !== 'email-composer') return;
        this.cb([{ target: el, contentRect: { width, height: 700 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FixedWidthObserver);
  }
  const panel = (side: 'left' | 'right') => document.querySelector<HTMLElement>(`[data-composer-sidebar="${side}"]`)!;

  afterEach(() => {
    vi.unstubAllGlobals();
    try {
      localStorage.removeItem('composerPluginSidebarCollapsed:left');
      localStorage.removeItem('composerPluginSidebarCollapsed:right');
      localStorage.removeItem('composerPluginSidebarWidth:left');
      localStorage.removeItem('composerPluginSidebarWidth:right');
    } catch { /* ignore */ }
  });

  it('give both panels a fixed width beside a wide composer', () => {
    stubWidth(1400);
    offerSlots('p1', ['composer-sidebar', 'composer-sidebar-right']);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    for (const side of ['left', 'right'] as const) {
      expect(panel(side).dataset.composerSidebarMode).toBe('docked');
      expect(panel(side).style.width).toBe('260px');
    }
    expect(panel('left')).toContainElement(screen.getByTestId('slot-composer-sidebar'));
    expect(panel('right')).toContainElement(screen.getByTestId('slot-composer-sidebar-right'));
  });

  it('let the user drag a panel wider or narrower, within limits, and remember it', () => {
    stubWidth(1400);
    offerSlots('p1', ['composer-sidebar', 'composer-sidebar-right']);
    const { unmount } = render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    // A mouse drag, as pointer events with the button held (the handle follows pointers).
    const drag = (handle: HTMLElement, from: number, to: number) => {
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, buttons: 1, pointerType: 'mouse', clientX: from, clientY: 10 });
      fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, pointerType: 'mouse', clientX: to, clientY: 10 });
      fireEvent.pointerUp(document, { pointerId: 1, button: 0, buttons: 0, pointerType: 'mouse' });
    };
    // The right panel's handle is on its left edge: dragging left widens it.
    const right = screen.getByTestId('composer-sidebar-resize-right');
    drag(right, 1000, 900);
    expect(panel('right').style.width).toBe('360px');
    // The left panel's handle is on its right edge: dragging left narrows it, down to the minimum.
    const left = screen.getByTestId('composer-sidebar-resize-left');
    drag(left, 300, 100);
    expect(panel('left').style.width).toBe('220px');
    fireEvent.keyDown(left, { key: 'ArrowRight' });
    expect(panel('left').style.width).toBe('230px');
    fireEvent.doubleClick(left);
    expect(panel('left').style.width).toBe('260px');
    expect(localStorage.getItem('composerPluginSidebarWidth:right')).toBe('360');
    unmount();

    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(panel('right').style.width).toBe('360px');
  });

  it('folds a widened panel sooner, since it needs the room', () => {
    localStorage.setItem('composerPluginSidebarWidth:right', '480');
    stubWidth(1000);
    offerSlots('p1', ['composer-sidebar-right']);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');
    expect(screen.queryByTestId('composer-sidebar-resize-right')).toBeNull();
  });

  it('fold the right panel, then both, when the composer would get too narrow', () => {
    stubWidth(900);
    offerSlots('p1', ['composer-sidebar', 'composer-sidebar-right']);
    const { unmount } = render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(panel('left').dataset.composerSidebarMode).toBe('docked');
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');
    expect(screen.queryByTestId('slot-composer-sidebar-right')).toBeNull();
    unmount();

    // The reading pane of a 1280 px window: an open panel would leave the
    // composer too narrow for its bottom bar.
    stubWidth(792);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(panel('left').dataset.composerSidebarMode).toBe('folded');
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');
  });

  it('let a plugin frame fill the panel, so it can pin a chat input at the bottom', () => {
    stubWidth(1400);
    offerSlots('p1', ['composer-sidebar-right'], { fill: ['composer-sidebar-right'] });
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    const frame = screen.getByTestId('slot-composer-sidebar-right');
    expect(frame.dataset.fill).toBe('true');
    expect(frame.closest('[data-plugin-slot]')!.className).toContain('h-full');
  });

  it('hand the panels the composer id, the draft and the selection', () => {
    stubWidth(1400);
    offerSlots('p1', ['composer-sidebar-right']);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    const props = slotProps(screen.getByTestId('slot-composer-sidebar-right'));
    expect(typeof props.composerId).toBe('string');
    expect((props.draft as { subject: string }).subject).toBe('Lunch');
    expect(props.selection).toEqual({ text: '', empty: true });
  });

  it('send the panels the selected text a moment after it changes', () => {
    useSettingsStore.setState({ plainTextMode: true });
    try {
      stubWidth(1400);
      offerSlots('p1', ['composer-sidebar-right']);
      const { container } = render(<EmailComposer initialData={{ ...DRAFT, body: 'Hello there' }} onClose={vi.fn()} />);
      vi.useFakeTimers();
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      textarea.focus();
      textarea.setSelectionRange(0, 5);
      act(() => { document.dispatchEvent(new Event('selectionchange')); });
      expect(slotProps(screen.getByTestId('slot-composer-sidebar-right')).selection).toEqual({ text: '', empty: true });

      act(() => { vi.advanceTimersByTime(200); });
      expect(slotProps(screen.getByTestId('slot-composer-sidebar-right')).selection).toEqual({ text: 'Hello', empty: false });

      textarea.setSelectionRange(2, 2);
      act(() => { document.dispatchEvent(new Event('selectionchange')); vi.advanceTimersByTime(200); });
      expect(slotProps(screen.getByTestId('slot-composer-sidebar-right')).selection).toEqual({ text: '', empty: true });
    } finally {
      useSettingsStore.setState({ plainTextMode: false });
    }
  });

  it('open, close and toggle on a plugin\'s request, for that composer only, and tell the slot to focus', () => {
    stubWidth(600);
    offerSlots('p1', ['composer-sidebar-right']);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');

    let open: boolean | null = false;
    act(() => { open = requestPanel('p1', 'composer-sidebar-right', 'open', { composerId: 'someone-else' }); });
    expect(open).toBeNull();
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');

    act(() => { open = requestPanel('p1', 'composer-sidebar-right', 'open', undefined); });
    expect(open).toBe(true);
    expect(panel('right').dataset.composerSidebarMode).toBe('overlay');
    const props = slotProps(screen.getByTestId('slot-composer-sidebar-right'));
    expect(props.focusRequest).toBe(1);
    const composerId = props.composerId as string;

    act(() => { open = requestPanel('p1', 'composer-sidebar-right', 'toggle', { composerId }); });
    expect(open).toBe(false);
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');

    act(() => { open = requestPanel('p1', 'composer-sidebar-right', 'toggle', { composerId }); });
    expect(open).toBe(true);
    expect(slotProps(screen.getByTestId('slot-composer-sidebar-right')).focusRequest).toBe(2);

    act(() => { open = requestPanel('p1', 'composer-sidebar-right', 'close', { composerId }); });
    expect(open).toBe(false);
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');
    // The left panel is not on this composer: nobody answers.
    act(() => { open = requestPanel('p1', 'composer-sidebar', 'open', { composerId }); });
    expect(open).toBeNull();
  });

  it('start folded when the plugin asks for it, until the user or the plugin opens it', () => {
    stubWidth(1400);
    offerSlots('p1', ['composer-sidebar-right'], { startFolded: ['composer-sidebar-right'] });
    const { unmount } = render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');
    act(() => { requestPanel('p1', 'composer-sidebar-right', 'open', undefined); });
    expect(panel('right').dataset.composerSidebarMode).toBe('docked');
    unmount();

    // Opened once: it stays open for the next composer.
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
    expect(panel('right').dataset.composerSidebarMode).toBe('docked');
    fireEvent.click(screen.getByRole('button', { name: 'plugin_panel_hide' }));
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');
  });

  it('answer no request on a phone, where the panels are not shown', () => {
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      stubWidth(390);
      offerSlots('p1', ['composer-sidebar-right']);
      render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);
      let open: boolean | null = true;
      act(() => { open = requestPanel('p1', 'composer-sidebar-right', 'open', undefined); });
      expect(open).toBeNull();
    } finally {
      window.innerWidth = width;
    }
  });

  it('open a folded panel over the composer when there is no room beside it', () => {
    stubWidth(600);
    offerSlots('p1', ['composer-sidebar-right']);
    render(<EmailComposer initialData={DRAFT} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'plugin_panel_show' }));
    expect(panel('right').dataset.composerSidebarMode).toBe('overlay');
    expect(panel('right').className).toContain('absolute');

    fireEvent.click(screen.getByRole('button', { name: 'plugin_panel_hide' }));
    expect(panel('right').dataset.composerSidebarMode).toBe('folded');
  });
});
