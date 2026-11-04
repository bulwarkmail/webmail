import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { EmailComposer, type ComposerDraftData } from '../email-composer';
import { JMAPClient } from '@/lib/jmap/client';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import { ToastContainer } from '@/components/ui/toast';
import en from '@/locales/en/common.json';

// Keep the real composer, stores, translations, upload transport and JMAP draft
// payloads. The transport endpoints below are entirely synthetic.
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
const staging = vi.hoisted(() => new Map<string, File>());
vi.mock('@/lib/plugin-storage', async original => ({
  ...await original<object>(),
  // IndexedDB File cloning is unrelated to the close/save race.
  fileStorage: {
    saveFile: async (id: string, file: File) => { staging.set(id, file); },
    getFile: async (id: string) => staging.get(id) ?? null,
    deleteFile: async (id: string) => { staging.delete(id); },
  },
}));

class Upload {
  static requests: Upload[] = [];
  file!: File;
  status = 0;
  responseText = '';
  responseType = '';
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  open() {}
  setRequestHeader() {}
  send(file: File) { this.file = file; Upload.requests.push(this); }
  abort() { this.aborted = true; this.onabort?.(); }
  succeed() {
    this.status = 201;
    this.responseText = JSON.stringify({ blobId: `blob-${this.file.name}`, size: this.file.size, type: this.file.type });
    this.onload?.();
  }
  fail() { this.status = 503; this.responseText = 'Synthetic rejection'; this.onload?.(); }
}
type Part = { blobId: string; name: string; type: string; size?: number };
type Draft = { subject: string; bodyValues: Record<string, { value: string }>; attachments?: Part[] };
type Props = React.ComponentProps<typeof EmailComposer>;
const original = {
  auth: useAuthStore.getState(), identity: useIdentityStore.getState(),
  settings: useSettingsStore.getState(),
};
let client: JMAPClient;
let creations: Draft[];
let rejectSave: boolean;
let finishSave: (() => void) | undefined;
let deferSave: boolean;

function Toasts() {
  const toasts = useToastStore(state => state.toasts);
  return <ToastContainer toasts={toasts} onClose={useToastStore.getState().removeToast} />;
}
beforeEach(async () => {
  creations = []; rejectSave = false; deferSave = false; finishSave = undefined;
  staging.clear(); Upload.requests = [];
  vi.stubGlobal('XMLHttpRequest', Upload);
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
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url) !== 'https://synthetic.example.test/api') throw new Error(`Unexpected URL: ${url}`);
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
          if (deferSave) await new Promise<void>(resolve => { finishSave = resolve; });
          created[key] = { id: `saved-${creations.length}` };
        }
        methodResponses.push([method, rejectSave
          ? { notCreated: { draft: { type: 'serverFail', description: 'Synthetic refusal' } } }
          : { created }, id]);
      } else if (method === 'Email/get') {
        methodResponses.push([method, { list: args.ids?.map(draftId => ({
          id: draftId, attachments: creations[Number(draftId.split('-')[1]) - 1]?.attachments ?? [],
        })) }, id]);
      } else if (method === 'Email/set' && args.destroy) methodResponses.push([method, { destroyed: args.destroy }, id]);
      else throw new Error(`Unexpected method: ${method}`);
    }
    return new Response(JSON.stringify({ methodResponses }));
  });
  useAuthStore.setState({ client, activeAccountId: 'login', isAuthenticated: true, isLoading: false,
    getClientForAccount: id => id === 'login' ? client : undefined,
    getAllConnectedClients: () => new Map([['login', client]]),
  });
  useIdentityStore.setState({ identities: [{ id: 'me', name: 'Me', email: 'me@example.test', mayDelete: false }] });
  useSettingsStore.setState({ plainTextMode: true, sendDelaySeconds: 0, sendConfirmation: false,
    attachmentReminderEnabled: false, emptySubjectWarningEnabled: false, placeholderWarningEnabled: false });
  useToastStore.getState().clearToasts();
});
afterEach(() => {
  cleanup(); client.disconnect();
  useAuthStore.setState(original.auth); useIdentityStore.setState(original.identity);
  useSettingsStore.setState(original.settings);
  useToastStore.getState().clearToasts(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const file = (name = 'A.txt') => new File([`Synthetic ${name}`], name, { type: 'text/plain' });
async function openComposer() {
  const closed = vi.fn();
  const send = vi.fn<NonNullable<Props['onSend']>>(async () => false as const);
  let reopen!: () => void;
  function Host() {
    const [open, setOpen] = useState(true);
    const [data, setData] = useState<ComposerDraftData | null>(null);
    const [session, setSession] = useState(0);
    reopen = () => {
      const draft = creations.at(-1)!;
      setData({ to: 'recipient@example.test', cc: '', bcc: '', subject: draft.subject,
        body: Object.values(draft.bodyValues)[0].value, showCc: false, showBcc: false,
        selectedIdentityId: 'me', subAddressTag: '', mode: 'compose', draftId: `saved-${creations.length}`,
        attachments: draft.attachments?.map(part => ({ ...part, size: file(part.name).size })), plainTextMode: true });
      setSession(value => value + 1); setOpen(true);
    };
    return <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {open && <EmailComposer key={session} initialData={data}
        onClose={() => { closed(); setOpen(false); }} onSend={send} />}
      <Toasts />
    </NextIntlClientProvider>;
  }
  const view = render(<Host />); await flush();
  fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'Draft subject' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Draft text' } });
  fireEvent.change(screen.getByPlaceholderText('Recipient email addresses'), { target: { value: 'recipient@example.test' } });
  fireEvent.keyDown(screen.getByPlaceholderText('Recipient email addresses'), { key: 'Enter' });
  return {
    ...view, closed, send,
    add: async (...files: File[]) => {
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files } }); await flush();
    },
    // Closing saves the draft without asking (it asks only when that fails).
    chooseSave: async () => {
      fireEvent.click(screen.getByTestId('composer-close'));
      await flush();
    },
    reopen: async () => { act(() => reopen()); await flush(); },
    closeAgain: () => fireEvent.click(screen.getByTestId('composer-close')),
  };
}
async function complete(index: number) { await act(async () => Upload.requests[index].succeed()); await flush(); }
function chip(name: string) { return screen.getByText(name).closest('.rounded-md') as HTMLElement; }
async function expectSaved(names: string[]) {
  await waitFor(() => expect(creations).toHaveLength(1));
  expect(creations[0].attachments?.map(part => [part.name, part.blobId]) ?? []).toEqual(names.map(name => [name, `blob-${name}`]));
  expect(creations[0].subject).toBe('Draft subject');
  expect(Object.values(creations[0].bodyValues).map(part => part.value).join('\n')).toContain('Draft text');
}

describe('Save and close with attachment uploads', () => {
  it('waits for A, saves its confirmed blob and latest text, then reopens with A', async () => {
    const c = await openComposer(); await c.add(file()); await c.chooseSave();
    expect(creations).toEqual([]); expect(c.closed).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Draft text edited while waiting' } });
    await complete(0); await expectSaved(['A.txt']);
    await waitFor(() => expect(c.closed).toHaveBeenCalledOnce());
    await c.reopen(); expect(screen.getByText('A.txt')).toBeVisible();
    expect(screen.getByLabelText('Message')).toHaveValue('Draft text edited while waiting');
  });
  it('waits for queued attachments and prevents autosaves during that wait', async () => {
    const c = await openComposer();
    await c.add(file(), file('B.txt')); await c.chooseSave();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(creations).toEqual([]); expect(Upload.requests).toHaveLength(1);
    await complete(0); expect(Upload.requests).toHaveLength(2); expect(creations).toEqual([]);
    await complete(1); await expectSaved(['A.txt', 'B.txt']);
    await waitFor(() => expect(c.closed).toHaveBeenCalledOnce());
  });
  it('retains the composer after upload failure and retries after remove/re-add', async () => {
    const c = await openComposer(); await c.add(file(), file('B.txt')); await c.chooseSave();
    await act(async () => Upload.requests[0].fail()); await flush();
    await waitFor(() => expect(Upload.requests).toHaveLength(2)); await complete(1);
    await waitFor(() => expect(screen.getAllByText('Failed to save')[0]).toBeVisible());
    expect(c.closed).not.toHaveBeenCalled(); expect(creations).toEqual([]);
    expect(within(chip('A.txt')).getByText('Upload failed')).toBeVisible();
    fireEvent.click(within(chip('A.txt')).getByRole('button', { name: 'Remove A.txt' }));
    await c.add(file()); await c.chooseSave(); expect(Upload.requests).toHaveLength(3);
    await complete(2); await expectSaved(['B.txt', 'A.txt']);
    await waitFor(() => expect(c.closed).toHaveBeenCalledOnce());
  });
  it('respects cancelling a pending A and removing queued B during the wait', async () => {
    const c = await openComposer(); await c.add(file(), file('B.txt')); await c.chooseSave();
    fireEvent.click(within(chip('B.txt')).getByRole('button', { name: 'Cancel upload' }));
    fireEvent.click(within(chip('A.txt')).getByRole('button', { name: 'Cancel upload' }));
    await expectSaved([]); await waitFor(() => expect(c.closed).toHaveBeenCalledOnce());
    expect(Upload.requests).toHaveLength(1); expect(Upload.requests[0].aborted).toBe(true);
  });
  it('can cancel waiting, continue editing, and save on a fresh attempt', async () => {
    const c = await openComposer(); await c.add(file()); await c.chooseSave();
    fireEvent.click(within(screen.getByTestId('composer-save-upload-wait')).getByRole('button', { name: 'Cancel' }));
    await complete(0); await new Promise(resolve => setTimeout(resolve, 200));
    expect(creations).toEqual([]); expect(c.closed).not.toHaveBeenCalled();
    await c.chooseSave(); await expectSaved(['A.txt']); await waitFor(() => expect(c.closed).toHaveBeenCalledOnce());
  });
  it('can discard during the wait without a later save or close follow-up', async () => {
    const c = await openComposer(); await c.add(file()); await c.chooseSave();
    // The bin asks nothing: the composer goes at once, with Undo on a toast.
    fireEvent.click(screen.getAllByTestId('composer-discard')[0]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await complete(0); await new Promise(resolve => setTimeout(resolve, 200));
    expect(creations).toEqual([]); expect(c.closed).toHaveBeenCalledOnce();
  });
  it('cancels only the save wait on unmount', async () => {
    const c = await openComposer(); await c.add(file()); await c.chooseSave(); c.unmount();
    await complete(0); await new Promise(resolve => setTimeout(resolve, 200));
    expect(creations).toEqual([]); expect(c.closed).not.toHaveBeenCalled();
  });
  it('saves and closes normally without uploads', async () => {
    const c = await openComposer(); await c.chooseSave(); await expectSaved([]);
    await waitFor(() => expect(c.closed).toHaveBeenCalledOnce());
  });
  it('keeps a refused draft open and retries without duplicate writes from repeated Save', async () => {
    const c = await openComposer(); rejectSave = true; deferSave = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await c.chooseSave(); expect(creations).toHaveLength(1);
    c.closeAgain();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(creations).toHaveLength(1);
    await act(async () => finishSave!());
    await waitFor(() => expect(screen.getAllByText('Failed to save')[0]).toBeVisible());
    expect(c.closed).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveValue('Draft text');
    rejectSave = false; deferSave = false; await c.chooseSave();
    await waitFor(() => expect(c.closed).toHaveBeenCalledOnce()); expect(creations).toHaveLength(2);
    errors.mockRestore();
  });
  it('repeated Save while waiting produces one final write', async () => {
    const c = await openComposer(); await c.add(file()); await c.chooseSave();
    await c.chooseSave(); expect(creations).toEqual([]);
    await complete(0); await expectSaved(['A.txt']);
    await waitFor(() => expect(c.closed).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 200)); expect(creations).toHaveLength(1);
  });
  it('a cancelled close wait does not cancel a later Send with pending uploads', async () => {
    const c = await openComposer(); await c.add(file()); await c.chooseSave();
    fireEvent.click(within(screen.getByTestId('composer-save-upload-wait')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getAllByTestId('composer-send')[0]); await flush();
    await complete(0); await waitFor(() => expect(c.send).toHaveBeenCalledOnce());
    expect(c.send.mock.calls[0][0].attachments?.map(part => part.name)).toEqual(['A.txt']);
  });
  it('keeps Send shortcuts from racing the final close save', async () => {
    const c = await openComposer(); await c.add(file()); await c.chooseSave();
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', ctrlKey: true });
    await complete(0); await expectSaved(['A.txt']);
    await waitFor(() => expect(c.closed).toHaveBeenCalledOnce()); expect(c.send).not.toHaveBeenCalled();
  });
  it('preserves Send waiting and successful upload payloads', async () => {
    const c = await openComposer(); await c.add(file());
    fireEvent.click(screen.getAllByTestId('composer-send')[0]); await flush(); expect(c.send).not.toHaveBeenCalled();
    await complete(0); await waitFor(() => expect(c.send).toHaveBeenCalledOnce());
    expect(c.send.mock.calls[0][0].attachments).toEqual([expect.objectContaining({ blobId: 'blob-A.txt', name: 'A.txt' })]);
  });
});
