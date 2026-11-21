import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { EmailComposer } from '@/components/email/email-composer';
import { UploadXHR, uploadClient } from '@/lib/__tests__/helpers/upload-xhr';
import { resetAnnouncerForTests } from '@/lib/announce';
import { resetComposerSessions } from '@/lib/plugin-composer-hooks';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import en from '@/locales/en/common.json';

// The composer's preview of a file the user attached saves it through an
// <a download>. The File keeps the type the browser gave it (text/html for a
// .html file); the URL the download is saved from is typed octet-stream.

vi.unmock('next-intl');
vi.mock('@/components/email/rich-text-editor', () => ({ RichTextEditor: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

const preview = vi.hoisted(() => ({ name: null as string | null, download: null as null | (() => Promise<void> | void) }));
vi.mock('@/components/files/file-preview-modal', () => ({
  FilePreviewModal: (props: { name: string; onDownload: () => Promise<void> | void }) => {
    preview.name = props.name;
    preview.download = props.onDownload;
    return null;
  },
}));

const stored = vi.hoisted(() => new Map<string, File>());
vi.mock('@/lib/plugin-storage', async original => ({
  ...await original<object>(),
  // No IndexedDB in jsdom.
  fileStorage: {
    saveFile: async (id: string, file: File) => { stored.set(id, file); },
    getFile: async (id: string) => stored.get(id) ?? null,
    deleteFile: async (id: string) => { stored.delete(id); },
  },
}));

const original = {
  auth: useAuthStore.getState(), identity: useIdentityStore.getState(), settings: useSettingsStore.getState(),
};
let client: ReturnType<typeof uploadClient>;
let minted: Map<string, Blob>;
let anchors: Array<{ href: string; download: string }>;

async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  stored.clear(); UploadXHR.instances = [];
  preview.name = null; preview.download = null;
  resetAnnouncerForTests(); resetComposerSessions();
  vi.stubGlobal('XMLHttpRequest', UploadXHR);
  client = uploadClient();
  Object.assign(client, { apiUrl: 'https://upload.invalid/api' });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
  useAuthStore.setState({ client, activeAccountId: 'login', isAuthenticated: true, isLoading: false,
    getClientForAccount: id => id === 'login' ? client : undefined,
    getAllConnectedClients: () => new Map([['login', client]]),
  });
  useIdentityStore.setState({ identities: [{ id: 'me', name: 'Me', email: 'me@example.test', mayDelete: false }] });
  useSettingsStore.setState({ plainTextMode: true, sendDelaySeconds: 0, sendConfirmation: false,
    attachmentReminderEnabled: false, emptySubjectWarningEnabled: false, placeholderWarningEnabled: false });
  minted = new Map();
  anchors = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const url = `blob:http://localhost/${minted.size + 1}`;
    minted.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    anchors.push({ href: this.getAttribute('href') ?? '', download: this.download });
  });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    for (const xhr of UploadXHR.instances) { xhr.abort(); await vi.advanceTimersByTimeAsync(0); }
  });
  client.disconnect(); resetAnnouncerForTests(); resetComposerSessions();
  useAuthStore.setState(original.auth); useIdentityStore.setState(original.identity);
  useSettingsStore.setState(original.settings);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers();
});

describe('downloading a file attached in the composer', () => {
  it('saves it under its name from a URL typed application/octet-stream', async () => {
    render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <EmailComposer onClose={() => {}} />
    </NextIntlClientProvider>);
    await advance();
    const page = new File(['<p>draft page</p>'], 'page.html', { type: 'text/html' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [page] } });
    await advance();
    act(() => UploadXHR.instances[0].load());
    await advance();

    fireEvent.click(screen.getByTitle('page.html'));
    await advance();
    expect(preview.name).toBe('page.html');
    await act(async () => { await preview.download!(); });

    expect(anchors).toEqual([{ href: expect.stringMatching(/^blob:/), download: 'page.html' }]);
    const blob = minted.get(anchors[0].href)!;
    expect(blob.type).toBe('application/octet-stream');
    expect(await blob.text()).toBe('<p>draft page</p>');
  });
});
