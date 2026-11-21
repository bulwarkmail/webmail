import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { composerDataFromDraft } from '@/lib/draft-composer-data';
import { sharedTagsKey, useSharedTagsStore } from '@/stores/shared-tags-store';

// ─── Heavy component mocks (mirrors composer-priority.test.tsx) ──────────────

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

// Where a message lives: the login's own account unless a test says otherwise.
const { blobContext } = vi.hoisted(() => ({
  blobContext: vi.fn((): { client: unknown; accountId: string | null; clientAccountId?: string } => ({ client: null, accountId: null })),
}));

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
    mailboxes: [] as unknown[],
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook, resolveEmailBlobContext: blobContext };
});

vi.mock('@/stores/settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/settings-store')>();
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
    nestedTags: false,
    isSenderTrusted: () => false,
    emailKeywords: [
      { id: 'work', label: 'Work', color: 'blue' },
      { id: 'urgent', label: 'Urgent', color: 'red' },
    ],
    addKeyword: vi.fn(),
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
    updateSetting: vi.fn(),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return {
    ...actual,
    useSettingsStore: hook,
  };
});

vi.mock('@/stores/contact-store', () => {
  const state = {
    contacts: [],
    getAutocomplete: async () => [],
    addToTrustedSendersBook: async () => {},
    isSenderTrusted: () => false,
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

vi.mock('@/stores/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      'options': 'Options',
      'tags': 'Tags',
      'send': 'Send',
      'new_tag': 'New tag',
    };
    return map[key] || key;
  },
  useLocale: () => 'en',
}));

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/mail',
}));

const DRAFT = {
  to: 'alice@example.com',
  cc: '',
  bcc: '',
  subject: 'Meeting',
  body: 'Hello',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

const openTagsMenu = () => {
  const menu = screen.getByTestId('composer-tags-menu');
  fireEvent.click(menu);
};

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;

async function send(onSend: ReturnType<typeof vi.fn>) {
  fireEvent.click(sendButton());
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0] as { keywords?: string[] };
}

describe('Composer Tags menu', () => {
  afterEach(() => {
    useAuthStore.setState({ client: null, activeAccountId: null });
    useSharedTagsStore.setState({ entries: {} });
    blobContext.mockReset();
    blobContext.mockReturnValue({ client: null, accountId: null });
    vi.clearAllMocks();
  });

  it('renders the Tags menu next to Options with count 0 initially', () => {
    render(<EmailComposer initialData={DRAFT} />);
    const tagsButton = screen.getByTestId('composer-tags-menu');
    expect(tagsButton).toBeInTheDocument();
    expect(tagsButton).toHaveAccessibleName('Tags');
    expect(tagsButton).not.toHaveTextContent('1');
  });

  it('opens TagPicker when clicked and lists tags', () => {
    render(<EmailComposer initialData={DRAFT} />);
    openTagsMenu();
    expect(screen.getByTestId('composer-tag-picker')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Urgent')).toBeInTheDocument();
  });

  it('moves through the tags with the arrow keys, as every menu does', async () => {
    render(<EmailComposer initialData={DRAFT} />);
    openTagsMenu();
    const work = screen.getByText('Work').closest('button')!;
    const urgent = screen.getByText('Urgent').closest('button')!;
    // The menu takes the focus on its first tag when it opens.
    await waitFor(() => expect(document.activeElement).toBe(work));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(urgent);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('tag-picker-new'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('composer-tag-picker')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByTestId('composer-tags-menu'));
  });

  it('updates activeCount badge when a tag is selected', () => {
    render(<EmailComposer initialData={DRAFT} />);
    openTagsMenu();
    const workRow = screen.getByText('Work').closest('button')!;
    fireEvent.click(workRow);

    const tagsButton = screen.getByTestId('composer-tags-menu');
    expect(tagsButton).toHaveTextContent('1');
  });

  it('sends the email with selected tags formatted as $label:<id>', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
    openTagsMenu();
    fireEvent.click(screen.getByText('Work').closest('button')!);
    fireEvent.click(screen.getByText('Urgent').closest('button')!);

    const sentData = await send(onSend);
    expect(sentData.keywords).toContain('$label:work');
    expect(sentData.keywords).toContain('$label:urgent');
  });

  it('inherits tags from replyTo message keywords', () => {
    render(
      <EmailComposer
        mode="reply"
        replyTo={{
          from: [{ email: 'bob@example.com' }],
          subject: 'Re: Project',
          body: 'Hi',
          keywords: { '$seen': true, '$label:work': true },
        }}
      />
    );
    const tagsButton = screen.getByTestId('composer-tags-menu');
    expect(tagsButton).toHaveTextContent('1');

    openTagsMenu();
    const workRow = screen.getByText('Work').closest('button')!;
    expect(workRow).toHaveAttribute('aria-checked', 'true');
  });

  it('saves the draft with selected tag keywords', async () => {
    const createDraft = vi.fn().mockResolvedValue('draft-99');
    useAuthStore.setState({
      client: {
        createDraft,
        getEmail: vi.fn().mockResolvedValue({ id: 'draft-99', attachments: [] }),
        hasDelayedSend: () => false,
        getMaxDelayedSend: () => 0,
      } as never,
      activeAccountId: 'acct-1' as never,
    });

    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    render(<EmailComposer initialData={DRAFT} requestCloseRef={requestCloseRef} onClose={vi.fn()} />);

    // Select a tag
    openTagsMenu();
    fireEvent.click(screen.getByText('Urgent').closest('button')!);

    // Close to save
    act(() => requestCloseRef.current!(vi.fn()));

    await waitFor(() => expect(createDraft).toHaveBeenCalled());
    expect(createDraft.mock.calls[0][13]).toMatchObject({
      keywords: ['$label:urgent'],
    });
  });

  it('restores tags from saved draft via composerDataFromDraft', () => {
    const mockEmail = {
      id: 'draft-1',
      subject: 'Draft subject',
      body: { value: 'Draft body' },
      keywords: { '$seen': true, '$draft': true, '$label:work': true },
    } as never;

    const data = composerDataFromDraft(mockEmail, {
      accountId: 'acc1',
      localAccountId: 'acc1',
      identities: [],
      noSubject: '(No Subject)',
    });

    expect(data.tags).toEqual(['work']);

    render(<EmailComposer initialData={data} />);
    const tagsButton = screen.getByTestId('composer-tags-menu');
    expect(tagsButton).toHaveTextContent('1');
  });

  it('preserves tags in onSaveState when unmounted', () => {
    const onSaveState = vi.fn();
    const { unmount } = render(<EmailComposer initialData={DRAFT} onSaveState={onSaveState} />);

    openTagsMenu();
    fireEvent.click(screen.getByText('Work').closest('button')!);

    unmount();
    expect(onSaveState).toHaveBeenCalledTimes(1);
    expect(onSaveState.mock.calls[0][0]).toMatchObject({
      tags: ['work'],
    });
  });

  it('offers the group account\'s shared tags when replying to a message in it', () => {
    blobContext.mockReturnValue({
      client: { getAccountId: () => 'own-account' },
      accountId: 'team-account',
      clientAccountId: 'login-1',
    });
    useSharedTagsStore.setState({
      entries: {
        [sharedTagsKey('login-1', 'team-account')]: {
          status: 'ready',
          tags: [{ id: 'team-review', label: 'Team review', color: 'green' }],
          stored: null,
          pending: [],
          discovered: {},
          loadedAt: 0,
          discoveredAt: 0,
          readFailedAt: null,
        },
      },
    });
    render(
      <EmailComposer
        mode="reply"
        replyTo={{
          from: [{ email: 'bob@example.com' }],
          subject: 'Re: Team Project',
          body: 'Hi team',
          sourceAccountId: 'team-account',
          sourceClientAccountId: 'login-1',
        }}
      />
    );
    openTagsMenu();
    expect(screen.getByText('Team review')).toBeInTheDocument();
    expect(screen.queryByText('Work')).not.toBeInTheDocument();
  });

  // #1613: "New tag" there made a personal tag, which the group's messages
  // showed by its raw id. With no right to change the group's tags (here not
  // known at all) there is no "New tag".
  it('offers no new tag in a group account whose tags the user may not change', () => {
    blobContext.mockReturnValue({
      client: { getAccountId: () => 'own-account' },
      accountId: 'team-account',
      clientAccountId: 'login-1',
    });
    useSharedTagsStore.setState({
      entries: {
        [sharedTagsKey('login-1', 'team-account')]: {
          status: 'ready',
          tags: [{ id: 'team-review', label: 'Team review', color: 'green' }],
          stored: null,
          pending: [],
          discovered: {},
          loadedAt: 0,
          discoveredAt: 0,
          readFailedAt: null,
        },
      },
    });
    render(
      <EmailComposer
        mode="reply"
        replyTo={{
          from: [{ email: 'bob@example.com' }],
          subject: 'Re: Team Project',
          body: 'Hi team',
          sourceAccountId: 'team-account',
          sourceClientAccountId: 'login-1',
        }}
      />
    );
    openTagsMenu();
    expect(screen.getByText('Team review')).toBeInTheDocument();
    expect(screen.queryByText('New tag')).not.toBeInTheDocument();
  });
});
