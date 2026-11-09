import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => ({ allowed: true }));
const toastError = vi.hoisted(() => vi.fn());
const forbidden = vi.hoisted(() => new Set<string>());

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock('@/hooks/use-device-policy', () => ({
  useDevicePolicy: () => ({ noDownloads: !policy.allowed, noExport: false }),
}));
vi.mock('@/lib/device-policy', () => ({
  canDownload: (account?: string) => policy.allowed && !forbidden.has(account ?? ''),
  canExport: () => true,
  deviceSubjectOf: () => null,
}));
vi.mock('@/lib/offline/availability', () => ({ scopeDecided: () => true }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: { getState: () => ({ activeAccountId: 'acct' }) } }));

import { useComposerEdits, type EditableAttachment } from '../use-composer-edits';
import { parkFilesForReply, readEditedFile, resetEditSessions, useEditSessions } from '@/lib/desktop/edit-attachments';

function fakeBridge() {
  return {
    canEdit: vi.fn((name: string) => !name.endsWith('.exe')),
    begin: vi.fn(async () => ({ ok: true as const, ticket: 't1' })),
    open: vi.fn(async () => ({ ok: true as const, id: 's1' })),
    reopen: vi.fn(async () => ({ ok: true as const, id: 's1' })),
    list: vi.fn(async () => []),
    settle: vi.fn(async () => useEditSessions.getState().sessions),
    read: vi.fn(async () => ({ ok: true as const, name: 'a.docx', type: 'x/y', data: new Uint8Array([1, 2]), hash: 'h2' })),
    taken: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    discard: vi.fn(async () => ({ held: [] })),
    forceDiscard: vi.fn(async () => ({ held: [] })),
    askClear: vi.fn(async () => true),
    clear: vi.fn(async () => ({ held: [] })),
    wipe: vi.fn(async () => ({ held: [] })),
    shown: vi.fn(),
    setSource: vi.fn(),
    claim: vi.fn(),
    onChange: vi.fn(() => () => {}),
  };
}

let bridge: ReturnType<typeof fakeBridge>;
let confirm: ReturnType<typeof vi.fn>;

const session = (over: Partial<{ id: string; name: string; source: string; changed: boolean; claimed: boolean; hash: string }> = {}) => ({
  id: 's1', name: 'a.docx', type: 'x/y', account: 'acct', source: '{"kind":"draft","draftId":"d1"}', changed: false, version: 0, hash: 'current', claimed: true, held: false, savedAs: false, lastChance: false, ...over,
});

const chipNamed = (name: string): EditableAttachment => ({ name, type: 'x/y', blobId: 'b' });

interface Setup {
  start: EditableAttachment[];
  draftId?: string | null;
  repliesTo?: string;
  /** What the composer's upload does with a file. */
  upload?: (file: File) => Partial<EditableAttachment>;
}

function setup({ start, draftId = 'd1', repliesTo, upload = () => ({ blobId: 'new-blob' }) }: Setup) {
  const load = vi.fn(async () => new Blob(['x']));
  bridge.list.mockResolvedValue(useEditSessions.getState().sessions as never);
  return renderHook(() => {
    const [attachments, setAttachments] = useState<EditableAttachment[]>(start);
    const addFiles = async (files: File[]) => {
      setAttachments((list) => [...list, ...files.map((file) => ({ file, name: file.name, type: file.type, uploading: false, ...upload(file) }))]);
    };
    const edits = useComposerEdits<EditableAttachment>({ attachments, setAttachments, addFiles, load, account: 'acct', draftId, repliesTo, ready: true });
    return { attachments, setAttachments, edits };
  });
}

beforeEach(() => {
  policy.allowed = true;
  bridge = fakeBridge();
  confirm = vi.fn(async () => 0);
  (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, edit: bridge, dialogs: { confirm } };
  resetEditSessions();
  toastError.mockClear();
});

afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('updating a chip', () => {
  const chip: EditableAttachment = { name: 'a.docx', type: 'x/y', blobId: 'old-blob', editSessionId: 's1' };

  it('takes the old file off only once the new one is up, and marks that version as taken', async () => {
    useEditSessions.setState({ sessions: [session({ changed: true })] });
    const { result } = setup({ start: [chip] });
    expect(result.current.edits.hasUpdate(result.current.attachments[0])).toBe(true);
    await act(() => result.current.edits.update(result.current.attachments[0]));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    const [only] = result.current.attachments;
    expect(only.blobId).toBe('new-blob');
    expect(only.file?.name).toBe('a.docx');
    await waitFor(() => expect(only.editSessionId ?? result.current.attachments[0].editSessionId).toBe('s1'));
    await waitFor(() => expect(bridge.taken).toHaveBeenCalledWith('s1', 'h2'));
    // Stays held by the composer throughout: it's the same session.
    expect(bridge.discard).not.toHaveBeenCalled();
  });

  it('keeps the old file and the offer when the upload fails', async () => {
    useEditSessions.setState({ sessions: [session({ changed: true })] });
    const { result } = setup({ start: [chip], upload: () => ({ error: true }) });
    await act(() => result.current.edits.update(result.current.attachments[0]));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.attachments[0].blobId).toBe('old-blob');
    expect(result.current.edits.hasUpdate(result.current.attachments[0])).toBe(true);
    expect(bridge.taken).not.toHaveBeenCalled();
  });

  it('says so when the program still holds the file', async () => {
    bridge.read.mockResolvedValueOnce({ ok: false, reason: 'busy' } as never);
    useEditSessions.setState({ sessions: [session({ changed: true })] });
    const { result } = setup({ start: [chip] });
    await act(() => result.current.edits.update(result.current.attachments[0]));
    expect(toastError).toHaveBeenCalledWith('read_busy');
    expect(result.current.attachments[0].blobId).toBe('old-blob');
  });

  it('refuses when the organisation has said no since', async () => {
    policy.allowed = false;
    useEditSessions.setState({ sessions: [session({ changed: true })] });
    const { result } = setup({ start: [chip] });
    await act(() => result.current.edits.update(result.current.attachments[0]));
    expect(bridge.read).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('blocked_policy');
    expect(result.current.attachments).toHaveLength(1);
  });
});

describe('starting from a chip', () => {
  it('fetches a server part, and the chip takes the session on', async () => {
    const { result } = setup({ start: [{ name: 'a.docx', type: 'x/y', blobId: 'b1' }] });
    await act(() => result.current.edits.startEdit(result.current.attachments[0]));
    expect(bridge.begin).toHaveBeenCalledWith('blob:acct:b1');
    await waitFor(() => expect(result.current.attachments[0].editSessionId).toBe('s1'));
    expect(bridge.claim).toHaveBeenCalledWith('s1', true);
    const [, file] = bridge.open.mock.calls[0] as unknown as [string, { source: string }];
    expect(JSON.parse(file.source)).toEqual({ kind: 'draft', draftId: 'd1' });
  });

  it('a chip with a session goes back to that session', async () => {
    const { result } = setup({ start: [{ name: 'a.docx', type: 'x/y', blobId: 'b1', editSessionId: 's1' }] });
    await act(() => result.current.edits.startEdit(result.current.attachments[0]));
    expect(bridge.begin).toHaveBeenCalledWith('session:s1');
  });

  it('offers it only for what the shell and the organisation allow', () => {
    const { result } = setup({ start: [] });
    expect(result.current.edits.canEditChip(chipNamed('a.docx'))).toBe(true);
    expect(result.current.edits.canEditChip(chipNamed('a.exe'))).toBe(false);
  });

  it('offers nothing under a policy', () => {
    policy.allowed = false;
    const { result } = setup({ start: [] });
    expect(result.current.edits.canEditChip(chipNamed('a.docx'))).toBe(false);
  });
});

describe('holding sessions', () => {
  it('claims what is on a chip, follows the draft id, and lets go when it closes, which is no end', async () => {
    const { result, rerender, unmount } = setup({ start: [{ name: 'a.docx', type: 'x/y', blobId: 'b', editSessionId: 's1' }] });
    expect(bridge.claim).toHaveBeenCalledWith('s1', true);
    expect(bridge.setSource).toHaveBeenCalledWith('s1', JSON.stringify({ kind: 'draft', draftId: 'd1' }));
    rerender();
    expect(result.current.attachments).toHaveLength(1);
    unmount();
    expect(bridge.claim).toHaveBeenLastCalledWith('s1', false);
    expect(bridge.discard).not.toHaveBeenCalled();
  });

  it('a chip taken off leaves the decision to main, which knows about a save from a moment ago', async () => {
    useEditSessions.setState({ sessions: [session({ id: 's1' }), session({ id: 's2', name: 'b.docx', changed: true })] });
    const { result } = setup({ start: [
      { name: 'a.docx', type: 'x/y', blobId: 'b', editSessionId: 's1' },
      { name: 'b.docx', type: 'x/y', blobId: 'c', editSessionId: 's2' },
    ] });
    act(() => result.current.setAttachments([]));
    await waitFor(() => expect(bridge.release).toHaveBeenCalledWith('s1', JSON.stringify({ kind: 'file' })));
    expect(bridge.release).toHaveBeenCalledWith('s2', JSON.stringify({ kind: 'file' }));
    expect(bridge.discard).not.toHaveBeenCalled();
  });

  it('a draft opened again finds its session by id and name', async () => {
    useEditSessions.setState({ sessions: [session({ claimed: false, changed: true })] });
    const { result } = setup({ start: [{ name: 'other.pdf', type: 'x/y', blobId: 'z' }, { name: 'a.docx', type: 'x/y', blobId: 'b' }] });
    await waitFor(() => expect(result.current.attachments[1].editSessionId).toBe('s1'));
    expect(result.current.attachments[0].editSessionId).toBeUndefined();
    expect(result.current.edits.hasUpdate(result.current.attachments[1])).toBe(true);
  });

  it('another draft leaves it alone', async () => {
    useEditSessions.setState({ sessions: [session({ claimed: false, source: '{"kind":"draft","draftId":"other"}' })] });
    const { result } = setup({ start: [{ name: 'a.docx', type: 'x/y', blobId: 'b' }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.attachments[0].editSessionId).toBeUndefined();
  });
});

describe('sending', () => {
  const chip: EditableAttachment = { name: 'a.docx', type: 'x/y', blobId: 'b', editSessionId: 's1' };

  it('goes on without a question when nothing waits', async () => {
    useEditSessions.setState({ sessions: [session()] });
    const { result } = setup({ start: [chip] });
    await expect(result.current.edits.confirmSend()).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before an older version goes out, with going back as the default', async () => {
    useEditSessions.setState({ sessions: [session({ changed: true })] });
    const { result } = setup({ start: [chip] });
    confirm.mockResolvedValueOnce(1);
    await expect(result.current.edits.confirmSend()).resolves.toBe(false);
    expect(confirm.mock.calls[0][0]).toMatchObject({ buttons: ['send_stale_send', 'send_stale_back'], defaultId: 1 });
    confirm.mockResolvedValueOnce(0);
    await expect(result.current.edits.confirmSend()).resolves.toBe(true);
  });

  it('asks in the app\'s own window where the shell has them; Escape is going back', async () => {
    const show = vi.fn(async (_request: unknown) => null as unknown);
    const desktop = (window as unknown as { bulwarkDesktop: { dialogs: Record<string, unknown> } }).bulwarkDesktop;
    desktop.dialogs = { confirm, show, cancel: vi.fn() };
    useEditSessions.setState({ sessions: [session({ changed: true })] });
    const { result } = setup({ start: [chip] });
    await expect(result.current.edits.confirmSend()).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(show.mock.calls[0][0]).toMatchObject({ message: [{ text: 'send_stale_detail' }], buttons: [{ label: 'send_stale_back', variant: 'secondary' }, { label: 'send_stale_send' }], defaultIndex: 0 });
    show.mockResolvedValueOnce({ button: 1 });
    await expect(result.current.edits.confirmSend()).resolves.toBe(true);
  });

  it('sees a save from a moment ago, which the list has not heard of', async () => {
    useEditSessions.setState({ sessions: [session()] });
    const { result } = setup({ start: [chip] });
    bridge.settle.mockResolvedValueOnce([session({ changed: true })] as never);
    confirm.mockResolvedValueOnce(1);
    await expect(result.current.edits.confirmSend()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('a chip holding the version on disk has nothing to ask about, even before main hears it went up', async () => {
    const outcome = await readEditedFile({ id: 's1', account: 'acct' });
    if (!outcome.ok) throw new Error('refused');
    useEditSessions.setState({ sessions: [session({ changed: true, hash: outcome.hash })] });
    const { result } = setup({ start: [{ file: outcome.file, name: 'a.docx', type: 'x/y', editSessionId: 's1', uploading: true }] });
    expect(result.current.edits.hasUpdate(result.current.attachments[0])).toBe(false);
    await expect(result.current.edits.confirmSend()).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('sent or discarded: main decides, also on a flag this page has wrong', async () => {
    // The page thinks nothing changed. Main has a save from a moment ago, and keeps it.
    useEditSessions.setState({ sessions: [session({ id: 's1' }), session({ id: 's2', name: 'b.docx', changed: true })] });
    const { result } = setup({ start: [chip, { name: 'b.docx', type: 'x/y', blobId: 'c', editSessionId: 's2' }] });
    act(() => result.current.edits.finish());
    expect(bridge.release).toHaveBeenCalledWith('s1', JSON.stringify({ kind: 'file' }));
    expect(bridge.release).toHaveBeenCalledWith('s2', JSON.stringify({ kind: 'file' }));
    expect(bridge.claim).toHaveBeenCalledWith('s2', false);
    expect(bridge.discard).not.toHaveBeenCalled();
  });

  it('says whether a send has anything to ask about', () => {
    const { result } = setup({ start: [chip] });
    expect(result.current.edits.holdsEdits()).toBe(true);
    const { result: other } = setup({ start: [chipNamed('a.docx')] });
    expect(other.current.edits.holdsEdits()).toBe(false);
  });
});

describe('a forwarded part', () => {
  it('from a message marked as phishing has no Edit', () => {
    const { result } = setup({ start: [] });
    expect(result.current.edits.canEditChip({ ...chipNamed('a.docx'), editBlocked: true })).toBe(false);
  });

  it('from another login follows that login\'s rules, and its session is filed there', async () => {
    const { result } = setup({ start: [{ ...chipNamed('a.docx'), sourceAccountId: 'other' }] });
    expect(result.current.edits.canEditChip(result.current.attachments[0])).toBe(true);
    await act(() => result.current.edits.startEdit(result.current.attachments[0]));
    expect(bridge.begin).toHaveBeenCalledWith('blob:other:b');
    const [, file] = bridge.open.mock.calls[0] as unknown as [string, { account: string }];
    expect(file.account).toBe('other');
  });

  it('from a login whose organisation says no has no Edit, whatever this one says', () => {
    const { result } = setup({ start: [] });
    forbidden.add('other');
    try {
      expect(result.current.edits.canEditChip({ ...chipNamed('a.docx'), sourceAccountId: 'other' })).toBe(false);
      expect(result.current.edits.canEditChip(chipNamed('a.docx'))).toBe(true);
    } finally {
      forbidden.clear();
    }
  });
});

describe('a reply from an offer', () => {
  it('takes the waiting file, and the session comes with it', async () => {
    const outcome = await readEditedFile({ id: 's1', account: 'acct' });
    if (!outcome.ok) throw new Error('refused');
    parkFilesForReply('e1', [outcome.file]);
    const { result } = setup({ start: [], repliesTo: 'e1', draftId: null });
    await waitFor(() => expect(result.current.attachments.map((a) => a.name)).toEqual(['a.docx']));
    await waitFor(() => expect(result.current.attachments[0].editSessionId).toBe('s1'));
    await waitFor(() => expect(bridge.taken).toHaveBeenCalledWith('s1', 'h2'));
    expect(bridge.claim).toHaveBeenCalledWith('s1', true);
  });

  it('a version counts as taken only once it is up', async () => {
    const outcome = await readEditedFile({ id: 's1', account: 'acct' });
    if (!outcome.ok) throw new Error('refused');
    parkFilesForReply('e1', [outcome.file]);
    const { result } = setup({ start: [], repliesTo: 'e1', draftId: null, upload: () => ({ uploading: true }) });
    await waitFor(() => expect(result.current.attachments[0]?.editSessionId).toBe('s1'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.taken).not.toHaveBeenCalled();
    act(() => result.current.setAttachments((list) => list.map((att) => ({ ...att, uploading: false, blobId: 'up' }))));
    await waitFor(() => expect(bridge.taken).toHaveBeenCalledWith('s1', 'h2'));
  });

  it('a reply to another message leaves it waiting', async () => {
    parkFilesForReply('e1', [new File(['x'], 'a.docx')]);
    const { result } = setup({ start: [], repliesTo: 'e2', draftId: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.attachments).toEqual([]);
  });
});

describe('in a browser', () => {
  it('nothing happens at all', () => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    const { result } = setup({ start: [{ name: 'a.docx', type: 'x/y', blobId: 'b' }] });
    expect(result.current.edits.canEditChip(chipNamed('a.docx'))).toBe(false);
    expect(result.current.attachments[0].editSessionId).toBeUndefined();
    expect(() => result.current.edits.finish()).not.toThrow();
  });
});
