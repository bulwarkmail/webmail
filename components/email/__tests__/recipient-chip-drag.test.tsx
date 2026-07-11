import { render, screen, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// ─── Heavy component mocks ────────────────────────────────────────────────────

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ onChange }: { onChange?: (html: string) => void }) => (
    React.createElement('div', { 'data-testid': 'rich-text-editor', onClick: () => onChange?.('') })
  ),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ ref: { current: null } }),
}));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

// ─── Store mocks ──────────────────────────────────────────────────────────────
// vi.mock factories are hoisted, so all values must be defined inline.

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
  const state = { identities: [], defaultIdentityId: null };
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
    sendDelaySeconds: 0,
    signaturePosition: 'above_quote',
    signatureSeparatorEnabled: false,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
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
    onSend: { call: async () => [] },
    beforeSend: { call: async () => [] },
  },
  contactHooks: {
    search: { call: async () => [] },
  },
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/reply-identity', () => ({
  resolveReplyFrom: () => null,
  findComposeIdentityId: () => null,
}));
vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/signature-utils', () => ({
  appendPlainTextSignature: (body: string) => body,
  getPlainTextSignature: () => '',
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: () => {} }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── DataTransfer polyfill ────────────────────────────────────────────────────

/** jsdom's built-in DataTransfer doesn't fully support setData/getData in synthetic drag events. */
class MockDataTransfer {
  private _data: Record<string, string> = {};
  types: string[] = [];
  effectAllowed = '';
  dropEffect = '';

  setData(type: string, data: string) {
    this._data[type] = data;
    if (!this.types.includes(type)) this.types.push(type);
  }

  getData(type: string): string {
    return this._data[type] ?? '';
  }

  setDragImage(_image: Element, _x: number, _y: number) {
    // no-op: jsdom has no rendering, but the chip drag handler calls this.
  }
}

// ─── Shared test data ─────────────────────────────────────────────────────────

const BASE_DATA = {
  to: 'alice@example.com, ',
  cc: '',
  bcc: '',
  subject: '',
  body: '',
  showCc: true,
  showBcc: true,
  selectedIdentityId: null,
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RecipientChipInput drag and drop', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders recipient chips with draggable="true"', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);

    const chipText = await screen.findByText('alice@example.com');
    const chipSpan = chipText.closest('[draggable]');
    expect(chipSpan).not.toBeNull();
    expect(chipSpan).toHaveAttribute('draggable', 'true');
  });

  it('onDragStart encodes the recipient and source field into dataTransfer', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);

    const chipText = await screen.findByText('alice@example.com');
    const chipSpan = chipText.closest('[draggable]') as HTMLElement;

    const dt = new MockDataTransfer();
    fireEvent.dragStart(chipSpan, { dataTransfer: dt });

    const payload = JSON.parse(dt.getData('application/x-recipient-chip'));
    expect(payload).toEqual({ recipient: { email: 'alice@example.com' }, fromField: 'to', fromIndex: 0 });
  });

  it('keeps a display name with a comma in a single chip (array model)', async () => {
    render(<EmailComposer initialData={{ ...BASE_DATA, to: '"Doo, John" <john@doo.org>, ' }} />);

    // One chip, displayed as "Doo, John (john@doo.org)" — not split on the comma.
    const chip = await screen.findByText('Doo, John (john@doo.org)');
    const chipSpan = chip.closest('[draggable]') as HTMLElement;
    expect(chipSpan).not.toBeNull();

    const dt = new MockDataTransfer();
    fireEvent.dragStart(chipSpan, { dataTransfer: dt });
    const payload = JSON.parse(dt.getData('application/x-recipient-chip'));
    expect(payload).toEqual({ recipient: { name: 'Doo, John', email: 'john@doo.org' }, fromField: 'to', fromIndex: 0 });
  });

  it('onDragEnd clears the opacity class on the chip', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);

    const chipText = await screen.findByText('alice@example.com');
    const chipSpan = chipText.closest('[draggable]') as HTMLElement;

    fireEvent.dragStart(chipSpan, { dataTransfer: new MockDataTransfer() });
    expect(chipSpan.className).toContain('opacity-50');

    fireEvent.dragEnd(chipSpan);
    expect(chipSpan.className).not.toContain('opacity-50');
  });

  it('dragOver on a different field container adds ring indicator; dragLeave removes it', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);

    await screen.findByText('alice@example.com');

    // The flex-wrap containers are the actual drop zones
    const allContainers = Array.from(document.querySelectorAll('[class*="flex-wrap"]'));
    // To-container has the draggable chip; cc-container doesn't
    const toContainer = allContainers.find(el => el.querySelector('[draggable]')) as HTMLElement;
    const ccContainer = allContainers.find(el => el !== toContainer) as HTMLElement;

    if (!ccContainer) return;

    const dt = new MockDataTransfer();
    dt.setData('application/x-recipient-chip', JSON.stringify({ recipient: { email: 'alice@example.com' }, fromField: 'to' }));

    fireEvent.dragOver(ccContainer, { dataTransfer: dt });
    expect(ccContainer.className).toContain('ring-primary');

    fireEvent.dragLeave(ccContainer, { relatedTarget: null });
    expect(ccContainer.className).not.toContain('ring-primary');
  });

  it('drop on a different field container moves the chip', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);
    await screen.findByText('alice@example.com');

    const allContainers = Array.from(document.querySelectorAll('[class*="flex-wrap"]'));
    const toContainer = allContainers.find(el => el.querySelector('[draggable]')) as HTMLElement;
    const ccContainer = allContainers.find(el => el !== toContainer) as HTMLElement;

    if (!toContainer || !ccContainer) return;

    const dt = new MockDataTransfer();
    dt.setData('application/x-recipient-chip', JSON.stringify({ recipient: { email: 'alice@example.com' }, fromField: 'to' }));
    fireEvent.dragOver(ccContainer, { dataTransfer: dt });
    act(() => {
      fireEvent.drop(ccContainer, { dataTransfer: dt });
    });

    // Chip should still appear exactly once (moved, not duplicated or lost)
    await screen.findByText('alice@example.com');
    expect(screen.getAllByText('alice@example.com')).toHaveLength(1);

    // The To container must now be empty
    expect(toContainer.querySelectorAll('[draggable]')).toHaveLength(0);
  });

  it('drop on the same field container is a no-op', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);
    await screen.findByText('alice@example.com');

    const allContainers = Array.from(document.querySelectorAll('[class*="flex-wrap"]'));
    const toContainer = allContainers.find(el => el.querySelector('[draggable]')) as HTMLElement;

    const dt = new MockDataTransfer();
    dt.setData('application/x-recipient-chip', JSON.stringify({ recipient: { email: 'alice@example.com' }, fromField: 'to' }));
    fireEvent.dragOver(toContainer, { dataTransfer: dt });
    act(() => {
      fireEvent.drop(toContainer, { dataTransfer: dt });
    });

    // Chip stays present exactly once
    expect(screen.getAllByText('alice@example.com')).toHaveLength(1);
  });

  it('dropping a chip onto the hidden Cc button shows the CC field', async () => {
    render(<EmailComposer initialData={{ ...BASE_DATA, showCc: false, showBcc: false }} />);
    await screen.findByText('alice@example.com');

    const ccButton = screen.getByRole('button', { name: 'Cc' });

    const dt = new MockDataTransfer();
    dt.setData('application/x-recipient-chip', JSON.stringify({ recipient: { email: 'alice@example.com' }, fromField: 'to' }));
    fireEvent.dragOver(ccButton, { dataTransfer: dt });
    act(() => {
      fireEvent.drop(ccButton, { dataTransfer: dt });
    });

    // cc_label is rendered by the mock translation as its key string
    const ccLabel = await screen.findByText('cc_label');
    expect(ccLabel).toBeInTheDocument();
  });

  // ─── Reordering within / across fields (#593) ─────────────────────────────────
  // jsdom ignores `clientX` in fireEvent's init for drag events (it's a
  // read-only MouseEvent getter) and gives every element a zero-size rect at
  // (0,0). So we dispatch events with `clientX` forced via defineProperty; with
  // the rect midpoint at 0, clientX>0 lands AFTER the hovered chip, <0 BEFORE.

  const THREE = { ...BASE_DATA, to: 'alice@example.com, bob@example.com, carol@example.com, ' };

  const chipByText = async (text: string) =>
    (await screen.findByText(text)).closest('[draggable]') as HTMLElement;

  /** Dispatch a drag event with a real clientX (fireEvent init drops it). */
  const fireDnd = (type: 'dragover' | 'drop', el: HTMLElement, dt: MockDataTransfer, clientX: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clientX', { value: clientX });
    Object.defineProperty(e, 'dataTransfer', { value: dt });
    act(() => { fireEvent(el, e); });
  };
  const BEFORE = -100;
  const AFTER = 100;

  /** Ordered chip labels of the field-container that holds `anchorText`. */
  const orderIn = (anchorText: string) => {
    const containers = Array.from(document.querySelectorAll('[class*="flex-wrap"]'));
    const c = containers.find(el =>
      Array.from(el.querySelectorAll('[draggable]')).some(d => d.textContent?.includes(anchorText))
    ) as HTMLElement;
    return Array.from(c.querySelectorAll('[draggable]')).map(el => el.textContent?.trim() ?? '');
  };

  /** All draggable chips (across fields) whose label contains `text`. */
  const draggableChipsWith = (text: string) =>
    Array.from(document.querySelectorAll('[draggable]')).filter(el => el.textContent?.includes(text));

  it('reorders a chip to the end of the same field (drop after the last chip)', async () => {
    render(<EmailComposer initialData={THREE} />);
    await screen.findByText('alice@example.com');
    const alice = await chipByText('alice@example.com');
    const carol = await chipByText('carol@example.com');

    const dt = new MockDataTransfer();
    fireEvent.dragStart(alice, { dataTransfer: dt });   // fromIndex 0
    fireDnd('dragover', carol, dt, AFTER);              // after carol -> index 3
    fireDnd('drop', carol, dt, AFTER);

    expect(orderIn('bob@example.com')).toEqual([
      'bob@example.com', 'carol@example.com', 'alice@example.com',
    ]);
  });

  it('reorders a chip to the front of the same field (drop before the first chip)', async () => {
    render(<EmailComposer initialData={THREE} />);
    await screen.findByText('carol@example.com');
    const carol = await chipByText('carol@example.com');
    const alice = await chipByText('alice@example.com');

    const dt = new MockDataTransfer();
    fireEvent.dragStart(carol, { dataTransfer: dt });   // fromIndex 2
    fireDnd('dragover', alice, dt, BEFORE);             // before alice -> index 0
    fireDnd('drop', alice, dt, BEFORE);

    expect(orderIn('alice@example.com')).toEqual([
      'carol@example.com', 'alice@example.com', 'bob@example.com',
    ]);
  });

  it('dropping a chip onto its own position leaves the order unchanged', async () => {
    render(<EmailComposer initialData={THREE} />);
    await screen.findByText('bob@example.com');
    const bob = await chipByText('bob@example.com');

    const dt = new MockDataTransfer();
    fireEvent.dragStart(bob, { dataTransfer: dt });     // fromIndex 1
    fireDnd('dragover', bob, dt, BEFORE);               // before itself -> index 1 (no-op)
    fireDnd('drop', bob, dt, BEFORE);

    expect(orderIn('bob@example.com')).toEqual([
      'alice@example.com', 'bob@example.com', 'carol@example.com',
    ]);
  });

  it('moves a chip into another field at the drop position (cross-field reorder)', async () => {
    render(<EmailComposer initialData={{ ...BASE_DATA, to: 'alice@example.com, ', cc: 'x@example.com, y@example.com, ' }} />);
    await screen.findByText('alice@example.com');
    const alice = await chipByText('alice@example.com');       // To
    const y = await chipByText('y@example.com');               // Cc

    const dt = new MockDataTransfer();
    fireEvent.dragStart(alice, { dataTransfer: dt });
    fireDnd('dragover', y, dt, BEFORE);               // before y -> index 1 in Cc
    fireDnd('drop', y, dt, BEFORE);

    // alice lands between x and y; To no longer holds it (count only real chips,
    // not the leftover jsdom drag-preview element)
    expect(orderIn('x@example.com')).toEqual([
      'x@example.com', 'alice@example.com', 'y@example.com',
    ]);
    expect(draggableChipsWith('alice@example.com')).toHaveLength(1);
  });

  it('shows a drop caret only while a chip is dragged over the field', async () => {
    render(<EmailComposer initialData={THREE} />);
    await screen.findByText('alice@example.com');
    const alice = await chipByText('alice@example.com');
    const bob = await chipByText('bob@example.com');

    const dt = new MockDataTransfer();
    fireEvent.dragStart(alice, { dataTransfer: dt });
    expect(document.querySelector('[data-testid="recipient-drop-caret"]')).toBeNull();

    fireDnd('dragover', bob, dt, BEFORE);
    expect(document.querySelector('[data-testid="recipient-drop-caret"]')).not.toBeNull();

    fireEvent.dragEnd(alice);
    expect(document.querySelector('[data-testid="recipient-drop-caret"]')).toBeNull();
  });
});
