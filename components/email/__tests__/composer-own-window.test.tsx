import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { EmailComposer, type ComposerDraftData, type ComposerPopOut } from '../email-composer';
import { JMAPClient } from '@/lib/jmap/client';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import en from '@/locales/en/common.json';
import { emailHooks } from '@/lib/plugin-hooks';

// Moving a draft to its own window, and a composer that is all its window
// shows. Real composer, stores and JMAP draft payloads over a synthetic server.
vi.unmock('next-intl');
vi.mock('@/components/email/rich-text-editor', () => ({ RichTextEditor: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

type Props = React.ComponentProps<typeof EmailComposer>;
type Draft = { subject: string };

const original = { auth: useAuthStore.getState(), identity: useIdentityStore.getState(), settings: useSettingsStore.getState() };
let client: JMAPClient;
let creations: Draft[];
let rejectSave: boolean;
let deferSave: boolean;
let finishSave: (() => void) | undefined;

beforeEach(async () => {
  creations = []; rejectSave = false; deferSave = false; finishSave = undefined;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
    capabilities: { 'urn:ietf:params:jmap:core': {} },
    accounts: { owner: { name: 'me@example.test', isPersonal: true, accountCapabilities: {} } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'owner' },
    apiUrl: 'https://synthetic.example.test/api', uploadUrl: 'https://synthetic.example.test/upload/{accountId}',
    downloadUrl: 'https://synthetic.example.test/download/{accountId}/{blobId}/{name}', eventSourceUrl: '',
  }))));
  client = new JMAPClient('https://synthetic.example.test', 'me@example.test', 'synthetic-password');
  await client.connect();
  vi.spyOn(client, 'ping').mockResolvedValue(undefined);
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const { methodCalls } = JSON.parse(String(init?.body)) as {
      methodCalls: Array<[string, { create?: Record<string, Draft>; ids?: string[]; destroy?: string[] }, string]>;
    };
    const methodResponses = [];
    for (const [method, args, id] of methodCalls) {
      if (method === 'Mailbox/get') methodResponses.push([method, { list: [{ id: 'drafts', role: 'drafts' }] }, id]);
      else if (method === 'Email/set' && args.create) {
        const created: Record<string, { id: string }> = {};
        for (const [key, draft] of Object.entries(args.create)) {
          creations.push(draft);
          if (deferSave) await new Promise<void>((resolve) => { finishSave = resolve; });
          created[key] = { id: `saved-${creations.length}` };
        }
        methodResponses.push([method, rejectSave
          ? { notCreated: { draft: { type: 'serverFail', description: 'Synthetic refusal' } } }
          : { created }, id]);
      } else if (method === 'Email/get') methodResponses.push([method, { list: (args.ids ?? []).map((draftId) => ({ id: draftId, attachments: [] })) }, id]);
      else if (method === 'Email/set') methodResponses.push([method, { destroyed: args.destroy ?? [] }, id]);
      else methodResponses.push([method, {}, id]);
    }
    return new Response(JSON.stringify({ methodResponses }));
  });
  useAuthStore.setState({ client, activeAccountId: 'login', isAuthenticated: true, isLoading: false,
    getClientForAccount: (id) => id === 'login' ? client : undefined,
    getAllConnectedClients: () => new Map([['login', client]]),
  });
  useIdentityStore.setState({ identities: [{ id: 'me', email: 'me@example.test', name: 'Me', mayDelete: false } as never] });
  useSettingsStore.setState({ defaultSendDelay: 0 } as never);
  useToastStore.getState().clearToasts();
});

afterEach(() => {
  cleanup();
  client.disconnect();
  useAuthStore.setState(original.auth);
  useIdentityStore.setState(original.identity);
  useSettingsStore.setState(original.settings);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(props: Partial<Props>) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <EmailComposer mode="compose" onClose={vi.fn()} {...props} />
    </NextIntlClientProvider>,
  );
}

const subjectField = () => screen.getByPlaceholderText(en.email_composer.subject_placeholder);

function target(shown = true): ComposerPopOut & { handed: ComposerDraftData[]; cancelled: number } {
  const handed: ComposerDraftData[] = [];
  const window = {
    handed,
    cancelled: 0,
    handOver: async (data: ComposerDraftData) => { handed.push(data); return shown; },
    cancel: () => { window.cancelled += 1; },
  };
  return window;
}

const DRAFT: ComposerDraftData = { to: '', cc: '', bcc: '', subject: 'Old', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', mode: 'compose', draftId: null };

describe('"Open in new window" on a composer', () => {
  it('is not there without the host offering it: browsers stay as they are', () => {
    mount({});
    expect(screen.queryByTestId('composer-open-in-window')).toBeNull();
  });

  it('opens the window inside the click, before any save', async () => {
    const popOut = vi.fn(() => target());
    mount({ popOut });
    fireEvent.click(screen.getByTestId('composer-open-in-window'));
    // Synchronously: a browser only opens a window for a user action.
    expect(popOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(popOut.mock.results[0].value.handed).toHaveLength(1));
  });

  it('saves the text, hands over the same draft id, and closes here', async () => {
    const window = target();
    const onClose = vi.fn();
    const onSaveState = vi.fn();
    mount({ popOut: () => window, onClose, onSaveState });
    fireEvent.change(subjectField(), { target: { value: 'Moves along' } });
    fireEvent.click(screen.getByTestId('composer-open-in-window'));
    await waitFor(() => expect(window.handed).toHaveLength(1));
    const data = window.handed[0];
    expect(data.subject).toBe('Moves along');
    expect(creations.map((draft) => draft.subject)).toEqual(['Moves along']);
    expect(data.draftId).toBe('saved-1');
    expect(data.unsaved).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Not left behind in the host's "continue draft" slot.
    cleanup();
    expect(onSaveState).not.toHaveBeenCalled();
  });

  it('keeps a draft that is already saved under its id, without saving again', async () => {
    const window = target();
    mount({
      popOut: () => window,
      initialData: { to: '', cc: '', bcc: '', subject: 'Old', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', mode: 'compose', draftId: 'existing' },
    });
    fireEvent.click(screen.getByTestId('composer-open-in-window'));
    await waitFor(() => expect(window.handed).toHaveLength(1));
    expect(window.handed[0].draftId).toBe('existing');
    expect(creations).toEqual([]);
  });

  it('keeps the composer and calls it off when the other window never shows it', async () => {
    const window = target(false);
    const onClose = vi.fn();
    mount({ popOut: () => window, onClose });
    fireEvent.change(subjectField(), { target: { value: 'Still here' } });
    fireEvent.click(screen.getByTestId('composer-open-in-window'));
    await waitFor(() => expect(window.cancelled).toBe(1));
    expect(onClose).not.toHaveBeenCalled();
    expect((subjectField() as HTMLInputElement).value).toBe('Still here');
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain(en.pwaWindows.window_not_ready);
  });

  it('does not close here before the other window shows it, also after a failed save', async () => {
    rejectSave = true;
    let show: (shown: boolean) => void = () => {};
    const handed: ComposerDraftData[] = [];
    const onClose = vi.fn();
    mount({
      popOut: () => ({ cancel: vi.fn(), handOver: (data) => { handed.push(data); return new Promise((resolve) => { show = resolve; }); } }),
      onClose,
    });
    fireEvent.change(subjectField(), { target: { value: 'Refused' } });
    fireEvent.click(screen.getByTestId('composer-open-in-window'));
    await waitFor(() => expect(handed).toHaveLength(1));
    expect(handed[0].unsaved).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    show(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('takes the send options along', async () => {
    const window = target();
    mount({ popOut: () => window, initialData: { ...DRAFT, requestReadReceipt: true, requestDsn: true, requireTls: true } });
    fireEvent.click(screen.getByTestId('composer-open-in-window'));
    await waitFor(() => expect(window.handed).toHaveLength(1));
    expect(window.handed[0]).toMatchObject({ requestReadReceipt: true, requestDsn: true, requireTls: true });
  });

  it('stays open and says why when the browser blocks the window', async () => {
    const onClose = vi.fn();
    mount({ popOut: () => null, onClose });
    fireEvent.change(subjectField(), { target: { value: 'Stays' } });
    fireEvent.click(screen.getByTestId('composer-open-in-window'));
    await waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain(en.pwaWindows.popup_blocked));
    expect(onClose).not.toHaveBeenCalled();
    expect((subjectField() as HTMLInputElement).value).toBe('Stays');
  });
});

describe('a composer that is all its window shows', () => {
  function unload() {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it('asks before the window closes with unsaved text, and saves meanwhile', async () => {
    const onUnloadState = vi.fn();
    mount({ ownWindow: { onUnloadState } });
    fireEvent.change(subjectField(), { target: { value: 'Not saved yet' } });
    const event = unload();
    expect(event.defaultPrevented).toBe(true);
    expect(onUnloadState.mock.calls[0][0]).toMatchObject({ subject: 'Not saved yet', unsaved: true });
    await waitFor(() => expect(creations.map((draft) => draft.subject)).toEqual(['Not saved yet']));
  });

  it('hands unsaved text to another window as it closes, with no prompt and no save of its own', () => {
    const rescueDraft = vi.fn(() => true);
    mount({ ownWindow: { rescueDraft } });
    fireEvent.change(subjectField(), { target: { value: 'Rescued' } });
    expect(unload().defaultPrevented).toBe(false);
    expect(rescueDraft).toHaveBeenCalledTimes(1);
    expect(rescueDraft.mock.calls[0]).toEqual([expect.objectContaining({ subject: 'Rescued', draftId: undefined })]);
    expect(creations).toEqual([]);
  });

  it('replaces the version it holds when another window saves it', () => {
    const rescueDraft = vi.fn(() => true);
    mount({
      ownWindow: { rescueDraft },
      initialData: { to: '', cc: '', bcc: '', subject: 'Old', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', mode: 'compose', draftId: 'saved-before' },
    });
    fireEvent.change(subjectField(), { target: { value: 'New' } });
    unload();
    expect(rescueDraft.mock.calls[0]).toEqual([expect.objectContaining({ subject: 'New', draftId: 'saved-before' })]);
  });

  it('asks and saves itself when no other window can take it', async () => {
    const rescueDraft = vi.fn(() => false);
    mount({ ownWindow: { rescueDraft } });
    fireEvent.change(subjectField(), { target: { value: 'Nobody home' } });
    expect(unload().defaultPrevented).toBe(true);
    await waitFor(() => expect(creations.map((draft) => draft.subject)).toEqual(['Nobody home']));
  });

  it('does not hand it over after a failed save: that window would likely fail too, with nobody looking', async () => {
    rejectSave = true;
    const rescueDraft = vi.fn(() => true);
    mount({ ownWindow: { rescueDraft } });
    fireEvent.change(subjectField(), { target: { value: 'Server down' } });
    await waitFor(() => expect(creations).toHaveLength(1), { timeout: 4000 });
    await waitFor(() => expect(unload().defaultPrevented).toBe(true));
    expect(rescueDraft).not.toHaveBeenCalled();
  });

  it('does not hand it over while the browser is offline', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const rescueDraft = vi.fn(() => true);
    mount({ ownWindow: { rescueDraft } });
    fireEvent.change(subjectField(), { target: { value: 'Wi-Fi gone' } });
    expect(unload().defaultPrevented).toBe(true);
    expect(rescueDraft).not.toHaveBeenCalled();
    onLine.mockRestore();
  });

  it('does not hand it over with a save running: two saves would make two drafts', async () => {
    deferSave = true;
    const rescueDraft = vi.fn(() => true);
    mount({ ownWindow: { rescueDraft } });
    fireEvent.change(subjectField(), { target: { value: 'Saving' } });
    await waitFor(() => expect(creations).toHaveLength(1), { timeout: 4000 });
    expect(unload().defaultPrevented).toBe(true);
    expect(rescueDraft).not.toHaveBeenCalled();
    finishSave?.();
  });

  it('asks when the window closes during a send', async () => {
    let finish: () => void = () => {};
    const onSend = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    mount({
      ownWindow: {}, onSend, onClose,
      initialData: { ...DRAFT, to: 'them@example.test', subject: 'Going', body: '<p>Hello</p>' },
    });
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalled(), { timeout: 4000 });
    expect(unload().defaultPrevented).toBe(true);
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(unload().defaultPrevented).toBe(false);
  });

  it('counts text handed in unsaved as unsaved: it asks, and saves it', async () => {
    const rescueDraft = vi.fn(() => false);
    mount({ ownWindow: { rescueDraft }, initialData: { ...DRAFT, subject: 'Handed in', unsaved: true } });
    expect(unload().defaultPrevented).toBe(true);
    await waitFor(() => expect(creations.map((draft) => draft.subject)).toEqual(['Handed in']));
  });

  it('saves text handed in unsaved by itself, untouched', async () => {
    mount({ ownWindow: {}, initialData: { ...DRAFT, subject: 'Autosaved after the move', unsaved: true } });
    await waitFor(() => expect(creations.map((draft) => draft.subject)).toEqual(['Autosaved after the move']), { timeout: 4000 });
  });

  it('keeps the draft to itself when a plugin has a say in what is saved', async () => {
    const rescueDraft = vi.fn(() => true);
    const hook = emailHooks.onBeforeDraftAutoSave.register('test', (draft: unknown) => draft as never);
    try {
      mount({ ownWindow: { rescueDraft } });
      fireEvent.change(subjectField(), { target: { value: 'Encrypted, say' } });
      expect(unload().defaultPrevented).toBe(true);
      expect(rescueDraft).not.toHaveBeenCalled();
    } finally {
      hook.dispose();
    }
  });

  // Escape in a pop-out or quick compose window: the same as anywhere,
  // saved and kept, and the main window says so (this one is gone).
  it('saves on Escape, closes, and hands "Draft saved" to the main window', async () => {
    const onDraftKept = vi.fn();
    const onClose = vi.fn();
    mount({ ownWindow: { onDraftKept }, onClose });
    fireEvent.change(subjectField(), { target: { value: 'Kept on Escape' } });
    fireEvent.keyDown(subjectField(), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(creations.map((draft) => draft.subject)).toEqual(['Kept on Escape']);
    expect(onDraftKept).toHaveBeenCalledWith('saved-1', expect.objectContaining({ localAccountId: expect.anything() }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('lets an untouched composer go without a word', () => {
    mount({ ownWindow: {} });
    expect(unload().defaultPrevented).toBe(false);
    expect(creations).toEqual([]);
  });

  it('does not ask again, or save again, once the autosave has it', async () => {
    const onDraftSaved = vi.fn();
    mount({ ownWindow: { onDraftSaved } });
    fireEvent.change(subjectField(), { target: { value: 'Autosaved' } });
    await waitFor(() => expect(creations).toHaveLength(1), { timeout: 4000 });
    await waitFor(() => expect(onDraftSaved).toHaveBeenCalled());
    // Says where it lives: a reload after a crash has only the address to go by.
    expect(onDraftSaved.mock.calls[0][1]).toEqual(expect.objectContaining({ localAccountId: expect.anything() }));
    expect(unload().defaultPrevented).toBe(false);
    expect(creations).toHaveLength(1);
  });

  it('keeps today\'s behaviour outside a window of its own: no prompt', () => {
    mount({});
    fireEvent.change(subjectField(), { target: { value: 'In the main window' } });
    expect(unload().defaultPrevented).toBe(false);
  });

  it('closes itself after the send, and writes no draft on the way out', async () => {
    const onClose = vi.fn();
    const onSend = vi.fn(async () => {});
    mount({
      ownWindow: {}, onSend, onClose,
      initialData: { to: 'them@example.test', cc: '', bcc: '', subject: 'Off it goes', body: '<p>Hello</p>', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', mode: 'compose', draftId: null },
    });
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalled(), { timeout: 4000 });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const saved = creations.length;
    expect(unload().defaultPrevented).toBe(false);
    expect(creations).toHaveLength(saved);
  });
});

describe('back online', () => {
  it('saves what could not be saved while offline, so "saved in Drafts once you are back online" holds', async () => {
    let onLine = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
    rejectSave = true;
    mount({});
    onLine = false;
    act(() => { window.dispatchEvent(new Event('offline')); });
    fireEvent.change(subjectField(), { target: { value: 'Written on a train' } });
    await waitFor(() => expect(creations).toHaveLength(1), { timeout: 4000 });

    rejectSave = false;
    onLine = true;
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(creations).toHaveLength(2));
    expect(creations[1].subject).toBe('Written on a train');
  });
});
