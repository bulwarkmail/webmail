import React, { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { EmailComposer, type ComposerDraftData } from '@/components/email/email-composer';
import { UploadXHR, uploadClient } from '@/lib/__tests__/helpers/upload-xhr';
import { resetAnnouncerForTests } from '@/lib/announce';
import { emailHooks } from '@/lib/plugin-hooks';
import { fileStorage } from '@/lib/plugin-storage';
import { resetComposerSessions } from '@/lib/plugin-composer-hooks';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import en from '@/locales/en/common.json';

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
  auth: useAuthStore.getState(), identity: useIdentityStore.getState(), settings: useSettingsStore.getState(),
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
  resources.files.clear(); resources.progress.clear(); UploadXHR.instances = [];
  resetAnnouncerForTests(); resetComposerSessions();
  vi.stubGlobal('XMLHttpRequest', UploadXHR);
  client = uploadClient();
  Object.assign(client, { apiUrl: 'https://upload.invalid/api' });
  // Only synthetic draft autosaves are allowed; no bootstrap or real traffic.
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url) !== 'https://upload.invalid/api') throw new Error(`Unexpected URL: ${url}`);
    const { methodCalls } = JSON.parse(String(init?.body)) as {
      methodCalls: Array<[string, { create?: Record<string, { attachments?: unknown[] }>; ids?: string[]; destroy?: string[] }, string]>;
    };
    return new Response(JSON.stringify({ methodResponses: methodCalls.map(([method, args, id]) => {
      if (method === 'Mailbox/get') return [method, { list: [{ id: 'drafts', role: 'drafts' }] }, id];
      if (method === 'Email/set') return [method, {
        created: Object.fromEntries(Object.keys(args.create ?? {}).map(key => [key, { id: 'saved' }])),
        destroyed: args.destroy,
      }, id];
      if (method === 'Email/get') return [method, { list: args.ids?.map(id => ({ id, attachments: [] })) }, id];
      throw new Error(`Unexpected method: ${method}`);
    }) }));
  }));
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
  useSettingsStore.setState(original.settings); useToastStore.getState().clearToasts();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers();
});

type Control = 'close' | 'toolbar';
async function openComposer(strict = false) {
  const closed = vi.fn();
  let reopen!: () => void;
  function Host() {
    const [open, setOpen] = useState(true);
    const [session, setSession] = useState(0);
    const [data, setData] = useState<ComposerDraftData | null>(null);
    reopen = () => {
      setData({ to: 'recipient@example.test', cc: '', bcc: '', subject: 'B subject', body: 'B new text',
        showCc: false, showBcc: false, selectedIdentityId: 'me', subAddressTag: '', mode: 'compose',
        draftId: null, plainTextMode: true });
      setSession(value => value + 1); setOpen(true);
    };
    return <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {open && <EmailComposer key={session} initialData={data} onClose={() => { closed(); setOpen(false); }} />}
    </NextIntlClientProvider>;
  }
  render(strict ? <StrictMode><Host /></StrictMode> : <Host />);
  await advance();
  fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'A subject' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'A text' } });
  return {
    closed,
    add: async (...files: File[]) => {
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files } }); await advance();
    },
    dialog: (control: Control) => {
      fireEvent.click(screen.getByTestId(control === 'close' ? 'composer-close' : 'composer-discard'));
      return within(screen.getByRole('alertdialog'));
    },
    reopen: async () => { act(() => reopen()); await advance(); },
  };
}
function expectNewComposer() {
  expect(screen.getByTestId('composer-subject')).toHaveValue('B subject');
  expect(screen.getByLabelText('Message')).toHaveValue('B new text');
  expect(screen.getByText('B.txt')).toBeVisible();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText('A.txt')).toBeNull(); expect(screen.queryByText('C.txt')).toBeNull();
}
const modes = (['close', 'toolbar'] as const).flatMap(control => [false, true].map(strict => ({ control, strict })));

describe('explicit Discard with pending attachment uploads', () => {
  describe.each(modes)('$control control, Strict Mode=$strict', ({ control, strict }) => {
    it.each(['success', 'network', 'HTTP rejection', 'timeout'] as const)('ignores late %s, cancels A/C and preserves B', async terminal => {
      const uploaded = vi.spyOn(emailHooks.onAfterAttachmentUpload, 'emit');
      const upload = vi.spyOn(client, 'uploadBlob');
      const c = await openComposer(strict); await c.add(file('A.txt'), file('C.txt'));
      expect(UploadXHR.instances).toHaveLength(1);
      const a = UploadXHR.instances[0];
      const late = { load: a.onload, error: a.onerror, timeout: a.ontimeout, progress: a.upload.onprogress };
      const signal = (upload.mock.calls[0][1] as { signal: AbortSignal }).signal;
      const removeListener = vi.spyOn(signal, 'removeEventListener');
      const settled = vi.fn();
      void upload.mock.results[0].value.then(settled, settled);
      expect([...resources.files.values()].map(f => f.name)).toEqual(['A.txt']);
      expect(resources.progress.size).toBe(1);
      fireEvent.click(c.dialog(control).getByRole('button', { name: /^Discard$/ })); await advance();
      await c.reopen(); await c.add(file('B.txt')); await complete(1);
      expectNewComposer();

      act(() => {
        if (terminal === 'success') { a.load(); late.load?.(); }
        else if (terminal === 'network') late.error?.();
        else if (terminal === 'HTTP rejection') { a.load(503, 'synthetic rejection'); late.load?.(); }
        late.progress?.(new ProgressEvent('progress', { loaded: 1, total: 10, lengthComputable: true }));
      });
      await advance();
      if (terminal !== 'timeout') {
        expect(useToastStore.getState().toasts.filter(t => t.type === 'error')).toEqual([]);
        expect(uploaded.mock.calls.map(([attachment]) => attachment.name)).toEqual(['B.txt']);
      }
      await advance(300_000);
      act(() => late.timeout?.()); await advance();

      expect(useToastStore.getState().toasts.filter(t => t.type === 'error')).toEqual([]);
      expect(uploaded.mock.calls.map(([attachment]) => attachment.name)).toEqual(['B.txt']);
      expect(upload.mock.calls.map(([f]) => f.name)).toEqual(['A.txt', 'B.txt']);
      expect(UploadXHR.instances.map(xhr => xhr.body?.name)).toEqual(['A.txt', 'B.txt']);
      expect(signal.aborted).toBe(true); expect(a.abort).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'AbortError' }));
      expect(removeListener).toHaveBeenCalledOnce();
      expect(a.onload).toBeNull(); expect(a.onerror).toBeNull(); expect(a.ontimeout).toBeNull();
      expect(a.upload.onprogress).toBeNull();
      expect(resources.files.size).toBe(0); expect(resources.progress.size).toBe(0);
      expectNewComposer(); expect(c.closed).toHaveBeenCalledOnce();
    });

    it('keeps active and queued uploads when the close/discard dialog is cancelled', async () => {
      const uploaded = vi.spyOn(emailHooks.onAfterAttachmentUpload, 'emit');
      const c = await openComposer(strict); await c.add(file('A.txt'), file('C.txt'));
      const dialog = c.dialog(control);
      expect(UploadXHR.instances[0].abort).not.toHaveBeenCalled();
      fireEvent.click(dialog.getByRole('button', { name: /^Cancel$/ })); await advance();
      await complete(0); expect(UploadXHR.instances[1].body?.name).toBe('C.txt'); await complete(1);
      expect(uploaded.mock.calls.map(([attachment]) => attachment.name)).toEqual(['A.txt', 'C.txt']);
      expect(c.closed).not.toHaveBeenCalled(); expect(resources.files.size).toBe(0); expect(resources.progress.size).toBe(0);
    });
  });

  it.each(['saveFile', 'getFile', 'deleteFile'] as const)('cancels while asynchronous %s is pending', async method => {
    const uploaded = vi.spyOn(emailHooks.onAfterAttachmentUpload, 'emit');
    const gate = deferred();
    const c = await openComposer(true);
    const entered = vi.fn();
    if (method === 'saveFile') {
      const original = fileStorage.saveFile;
      vi.spyOn(fileStorage, 'saveFile').mockImplementationOnce(async (...args) => {
        entered(); await gate.promise; return original(...args);
      });
    } else if (method === 'getFile') {
      const original = fileStorage.getFile;
      vi.spyOn(fileStorage, 'getFile').mockImplementationOnce(async (...args) => {
        entered(); await gate.promise; return original(...args);
      });
    } else {
      const original = fileStorage.deleteFile;
      vi.spyOn(fileStorage, 'deleteFile').mockImplementationOnce(async (...args) => {
        entered(); await gate.promise; return original(...args);
      });
    }
    await c.add(file('A.txt'), file('C.txt'));
    if (method === 'deleteFile') await complete(0);
    expect(entered).toHaveBeenCalledOnce();
    fireEvent.click(c.dialog('close').getByRole('button', { name: /^Discard$/ })); await advance();
    await c.reopen();
    await act(async () => { gate.resolve(); }); await advance();
    await c.add(file('B.txt')); await complete(UploadXHR.instances.findIndex(xhr => xhr.body?.name === 'B.txt'));
    expect(uploaded.mock.calls.map(([attachment]) => attachment.name)).toEqual(['B.txt']);
    expect(useToastStore.getState().toasts.filter(t => t.type === 'error')).toEqual([]);
    expect(UploadXHR.instances.map(xhr => xhr.body?.name)).toEqual(method === 'deleteFile' ? ['A.txt', 'B.txt'] : ['B.txt']);
    expect(resources.files.size).toBe(0); expect(resources.progress.size).toBe(0); expectNewComposer();
  });
});
