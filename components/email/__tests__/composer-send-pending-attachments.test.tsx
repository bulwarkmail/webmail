import React, { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { EmailComposer, type ComposerDraftData } from '@/components/email/email-composer';
import { UploadXHR, uploadClient } from '@/lib/__tests__/helpers/upload-xhr';
import { resetAnnouncerForTests } from '@/lib/announce';
import { resetComposerSessions } from '@/lib/plugin-composer-hooks';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import en from '@/locales/en/common.json';
import { usePolicyStore } from '@/stores/policy-store';

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

const resources = vi.hoisted(() => ({ files: new Map<string, File>(), progress: new Set<string>() }));
vi.mock('@/lib/plugin-storage', async original => ({
  ...await original<object>(),
  // Avoid IndexedDB File cloning; keep the composer's real staging lifecycle.
  fileStorage: {
    saveFile: async (id: string, file: File) => { resources.files.set(id, file); },
    getFile: async (id: string) => resources.files.get(id) ?? null,
    deleteFile: async (id: string) => { resources.files.delete(id); },
  },
}));
vi.mock('@/lib/upload-progress', async original => {
  const actual = await original<typeof import('@/lib/upload-progress')>();
  return { ...actual, onUploadProgress: (id: string, listener: (loaded: number, total: number) => void) => {
    resources.progress.add(id);
    const stop = actual.onUploadProgress(id, listener);
    return () => { stop(); resources.progress.delete(id); };
  } };
});

const original = {
  auth: useAuthStore.getState(), identity: useIdentityStore.getState(), settings: useSettingsStore.getState(), policy: usePolicyStore.getState(),
};
let client: ReturnType<typeof uploadClient>;
const file = (name: string) => new File(['synthetic attachment'], name, { type: 'text/plain' });
async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function complete(index: number) {
  act(() => UploadXHR.instances[index].load());
  await advance();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  usePolicyStore.setState({ loaded: true, fetching: false, partial: false });
  vi.spyOn(usePolicyStore.getState(), 'fetchPolicy').mockResolvedValue(undefined);
  resources.files.clear(); resources.progress.clear(); UploadXHR.instances = [];
  resetAnnouncerForTests(); resetComposerSessions();
  vi.stubGlobal('XMLHttpRequest', UploadXHR);
  client = uploadClient();
  Object.assign(client, { apiUrl: 'https://upload.invalid/api' });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK FORBIDDEN'); }));
  vi.spyOn(client, 'createDraft').mockResolvedValue('synthetic-saved');
  vi.spyOn(client, 'getEmail').mockResolvedValue({ id: 'synthetic-saved', attachments: [] } as never);
  vi.spyOn(client, 'sendEmail').mockRejectedValue(new Error('SUBMISSION FORBIDDEN'));
  vi.spyOn(client, 'sendRawEmail').mockRejectedValue(new Error('SUBMISSION FORBIDDEN'));
  vi.spyOn(client, 'submitEmail').mockRejectedValue(new Error('SUBMISSION FORBIDDEN'));
  waits.length = 0; delivery.pause = null;
  useAuthStore.setState({ client, activeAccountId: 'login', isAuthenticated: true, isLoading: false,
    getClientForAccount: id => id === 'login' ? client : undefined,
    getAllConnectedClients: () => new Map([['login', client]]),
  });
  useIdentityStore.setState({ identities: [{ id: 'me', name: 'Me', email: 'me@example.test', mayDelete: false }] });
  useSettingsStore.setState({ plainTextMode: true, sendDelaySeconds: 0, sendConfirmation: false,
    attachmentReminderEnabled: false, emptySubjectWarningEnabled: false, placeholderWarningEnabled: false });
  useToastStore.getState().clearToasts();
});
afterEach(async () => {
  cleanup();
  // Drain requests left by a failing assertion before restoring the transport.
  await act(async () => {
    for (const xhr of UploadXHR.instances) { xhr.abort(); await vi.advanceTimersByTimeAsync(0); }
  });
  client.disconnect(); resetAnnouncerForTests(); resetComposerSessions();
  useAuthStore.setState(original.auth); useIdentityStore.setState(original.identity);
  usePolicyStore.setState(original.policy);
  useSettingsStore.setState(original.settings); useToastStore.getState().clearToasts();
  expect(fetch).not.toHaveBeenCalled();
  expect(client.sendEmail).not.toHaveBeenCalled();
  expect(client.sendRawEmail).not.toHaveBeenCalled();
  expect(client.submitEmail).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers();
});

const waits = vi.hoisted(() => [] as Array<{ reads: number; result?: string }>);
const delivery = vi.hoisted(() => ({ pause: null as Promise<void> | null }));
vi.mock('@/lib/email-composer-utils', async original => {
  const actual = await original<typeof import('@/lib/email-composer-utils')>();
  return { ...actual, waitForPendingUploads: (...args: Parameters<typeof actual.waitForPendingUploads>) => {
    const wait = { reads: 0 } as typeof waits[number];
    waits.push(wait);
    const pause = delivery.pause;
    delivery.pause = null;
    // Observe the real helper; optionally delay delivery of its result to
    // exercise teardown between helper completion and the Send continuation.
    return actual.waitForPendingUploads(() => { wait.reads++; return args[0](); }, args[1], args[2])
      .then(async result => { wait.result = result; if (pause) await pause; return result; });
  } };
});
type Props = React.ComponentProps<typeof EmailComposer>;
const data = (name: string): ComposerDraftData => ({
  to: 'recipient@example.test', cc: '', bcc: '', subject: `${name} subject`, body: `${name} text`,
  showCc: false, showBcc: false, selectedIdentityId: 'me', subAddressTag: '', mode: 'compose',
  draftId: null, plainTextMode: true,
});
async function openComposer(strict: boolean) {
  const saved = vi.fn(); const closed = vi.fn(); const discarded = vi.fn(); const failed = vi.fn();
  const send = vi.fn<NonNullable<Props['onSend']>>(async () => false as const);
  const requestCloseRef = { current: null as null | (() => void) };
  let replace!: () => void; let hide!: () => void;
  function Host() {
    const [open, setOpen] = useState(true); const [session, setSession] = useState(0);
    const [initial, setInitial] = useState<ComposerDraftData>(data('A'));
    replace = () => { setInitial(data('B')); setSession(n => n + 1); setOpen(true); };
    hide = () => setOpen(false);
    return <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {open && <EmailComposer key={session} initialData={initial} onSaveState={saved}
        onClose={() => { closed(); setOpen(false); }} onSend={send} onSendFailed={failed}
        onDiscardDraft={discarded} requestCloseRef={requestCloseRef} />}
    </NextIntlClientProvider>;
  }
  render(strict ? <StrictMode><Host /></StrictMode> : <Host />);
  await advance();
  fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'A edited subject' } });
  await advance(1000); saved.mockClear();
  return {
    send, failed, saved, closed, discarded,
    add: async (...files: File[]) => {
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files } }); await advance();
    },
    sendNow: async () => { fireEvent.click(screen.getAllByTestId('composer-send')[0]); await advance(); },
    close: async () => { act(() => requestCloseRef.current?.()); await advance(); },
    replace: async () => { act(() => replace()); await advance(); },
    hide: async () => { act(() => hide()); await advance(); },
    discard: async () => {
      fireEvent.click(screen.getByTestId('composer-discard'));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /^Discard$/ }));
      await advance();
    },
  };
}
async function cancelCloseWait() {
  fireEvent.click(within(screen.getByTestId('composer-save-upload-wait')).getByRole('button', { name: 'Cancel' }));
  await advance();
}
function expectB() {
  expect(screen.getByTestId('composer-subject')).toHaveValue('B subject');
  expect(screen.getByLabelText('Message')).toHaveValue('B text');
  expect(screen.getByText('B.txt')).toBeVisible();
  expect(screen.queryByText('A.txt')).toBeNull(); expect(screen.queryByText('C.txt')).toBeNull();
}

// Host transitions mirror MailApp: message selection calls requestCloseRef;
// opening a separately keyed draft replaces the composer. No MailApp recovery
// decisions are modeled here: the outgoing snapshot is observed independently.
describe.each([false, true])('Send attachment wait, StrictMode=%s', strict => {
  it('completes a normal Send with confirmed attachments and no polling left', async () => {
    const c = await openComposer(strict); await c.add(file('A.txt')); await c.sendNow();
    expect(c.send).not.toHaveBeenCalled();
    await complete(0); await advance(150); await advance(10_000);
    expect(waits[0].result).toBe('completed'); expect(vi.getTimerCount()).toBe(0);
    expect(c.send).toHaveBeenCalledOnce();
    expect(c.send.mock.calls[0][0].attachments).toEqual([expect.objectContaining({ name: 'A.txt', blobId: 'blob-A.txt' })]);
  });

  it('establishes the no-Send timer baseline and preserves implicit recovery', async () => {
    const c = await openComposer(strict); await c.add(file('A.txt')); await c.hide();
    await complete(0); await advance(10_000);
    expect(waits).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    expect(c.saved).toHaveBeenCalledOnce();
    expect(c.saved.mock.calls[0][0]).toMatchObject({ subject: 'A edited subject', body: 'A text', attachments: [] });
  });

  describe.each(['unmount', 'replacement'] as const)('%s during Send', path => {
    it.each(['success', 'failure'] as const)('settles cancellation and leaves background %s uploads owned by the upload pipeline', async terminal => {
      const upload = vi.spyOn(client, 'uploadBlob');
      const c = await openComposer(strict); await c.add(file('A.txt'), file('C.txt')); await c.sendNow();
      const sendWait = waits[0];
      if (path === 'unmount') await c.hide(); else await c.replace();
      expect(c.saved).toHaveBeenCalledOnce();
      expect(c.saved.mock.calls[0][0]).toMatchObject({ subject: 'A edited subject', body: 'A text', attachments: [], unsaved: true });
      expect((upload.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(false);
      await advance(150);
      expect(sendWait.result).toBe('cancelled');
      const reads = sendWait.reads;
      if (terminal === 'success') await complete(0);
      else { act(() => UploadXHR.instances[0].error()); await advance(); }
      expect(UploadXHR.instances[1].body?.name).toBe('C.txt'); await complete(1);
      expect(UploadXHR.instances[0].abort).not.toHaveBeenCalled();
      expect(resources.files.size).toBe(0); expect(resources.progress.size).toBe(0);
      if (path === 'replacement') {
        await c.add(file('B.txt')); await complete(2); expectB();
      }
      await advance(10_000);
      expect(vi.getTimerCount()).toBe(0); await advance(60_000);
      expect(sendWait.reads).toBe(reads); expect(vi.getTimerCount()).toBe(0);
      expect(c.send).not.toHaveBeenCalled(); expect(c.closed).not.toHaveBeenCalled();
      expect(c.failed).not.toHaveBeenCalled(); expect(c.discarded).not.toHaveBeenCalled();
      if (path === 'replacement') expectB();
    });
  });

  it.each(['success', 'failure', 'removal'] as const)('keeps a requestClose-cancelled Send cancelled when %s beats the next poll', async terminal => {
    const c = await openComposer(strict); await c.add(file('A.txt')); await c.sendNow(); await c.close();
    expect(screen.getByTestId('composer-save-upload-wait')).toBeVisible();
    if (terminal === 'success') await complete(0);
    else if (terminal === 'failure') { act(() => UploadXHR.instances[0].error()); await advance(); }
    else { fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' })); await advance(); }
    await advance(150); await advance(10_000);
    expect(waits[0].result).toBe('cancelled'); expect(c.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); expect(c.saved).not.toHaveBeenCalled();
    if (terminal === 'failure') {
      expect(c.closed).not.toHaveBeenCalled(); expect(client.createDraft).not.toHaveBeenCalled();
      expect(screen.getByTestId('composer-subject')).toHaveValue('A edited subject');
    } else {
      expect(c.closed).toHaveBeenCalledOnce(); expect(client.createDraft).toHaveBeenCalledOnce();
    }
  });

  it('does not revive an old Send when close is cancelled and a subsequent Send starts', async () => {
    const c = await openComposer(strict); await c.add(file('A.txt')); await c.sendNow(); await c.close();
    await cancelCloseWait();
    await complete(0); await advance(150);
    expect(waits[0].result).toBe('cancelled'); expect(waits[1].result).toBe('cancelled');
    expect(c.send).not.toHaveBeenCalled(); expect(c.closed).not.toHaveBeenCalled();
    await c.add(file('C.txt')); await c.sendNow(); await complete(1); await advance(150); await advance(10_000);
    expect(c.send).toHaveBeenCalledOnce(); expect(waits[2].result).toBe('completed');
    expect(c.send.mock.calls[0][0].attachments?.map(a => a.name)).toEqual(['A.txt', 'C.txt']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('guards the continuation if teardown follows helper completion', async () => {
    const gate = deferred(); delivery.pause = gate.promise;
    const c = await openComposer(strict); await c.add(file('A.txt')); await c.sendNow();
    await complete(0); await advance(150);
    expect(waits[0].result).toBe('completed'); expect(c.send).not.toHaveBeenCalled();
    await c.hide(); await act(async () => gate.resolve()); await advance(10_000);
    expect(c.send).not.toHaveBeenCalled(); expect(c.saved).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps explicit Discard cancellation and replacement isolation', async () => {
    const c = await openComposer(strict); await c.add(file('A.txt'), file('C.txt')); await c.sendNow(); await c.discard();
    await advance(150); await c.replace(); await c.add(file('B.txt')); await complete(1); await advance(10_000);
    expect(waits[0].result).toBe('cancelled'); expect(vi.getTimerCount()).toBe(0);
    expect(UploadXHR.instances.map(x => x.body?.name)).toEqual(['A.txt', 'B.txt']);
    expect(UploadXHR.instances[0].abort).toHaveBeenCalledOnce();
    expect(c.saved).not.toHaveBeenCalled(); expect(c.closed).toHaveBeenCalledOnce(); expect(c.send).not.toHaveBeenCalled(); expectB();
  });

  it('still saves and closes normally while attachments are pending', async () => {
    const c = await openComposer(strict); await c.add(file('A.txt')); await c.close();
    expect(c.closed).not.toHaveBeenCalled(); expect(client.createDraft).not.toHaveBeenCalled();
    await complete(0); await advance(150); await advance(10_000);
    expect(waits[0].result).toBe('completed'); expect(client.createDraft).toHaveBeenCalledOnce();
    expect(c.closed).toHaveBeenCalledOnce(); expect(c.send).not.toHaveBeenCalled(); expect(c.saved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
