import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => ({ decided: true, download: true, export: true }));

vi.mock('@/lib/device-policy', () => ({
  canDownload: () => policy.download,
  canExport: () => policy.export,
}));
vi.mock('@/lib/offline/offline-mode', () => ({
  scopeDecided: () => policy.decided,
}));

import {
  canEditFile,
  editAllowed,
  editFileInfo,
  editForbidden,
  followEditSessions,
  parkFilesForReply,
  parseEditSource,
  readEditedFile,
  resetEditSessions,
  startAttachmentEdit,
  takeFilesForReply,
  useEditSessions,
  type StartEditInput,
} from '../edit-attachments';
import { setAppLockCheck } from '../app-lock-state';
import { runWipeCleaners } from '@/lib/offline/wipe-registry';
import { runBeforeSignOut } from '@/lib/sign-out-cleanup';

function fakeBridge() {
  return {
    canEdit: vi.fn((name: string) => !name.endsWith('.exe')),
    begin: vi.fn(async (_key: string) => ({ ok: true as const, ticket: 't1' } as { ok: true; ticket: string; open?: string } | { ok: false; reason: 'locked' })),
    open: vi.fn(async () => ({ ok: true as const, id: 's1' })),
    reopen: vi.fn(async () => ({ ok: true as const, id: 's1' })),
    list: vi.fn(async () => []),
    read: vi.fn(async () => ({ ok: true as const, name: 'a.docx', type: 'x/y', data: new Uint8Array([1, 2]), hash: 'h' })),
    taken: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    setSource: vi.fn(),
    claim: vi.fn(),
    onChange: vi.fn(() => () => {}),
  };
}

let bridge: ReturnType<typeof fakeBridge>;

const input = (over: Partial<StartEditInput> = {}): StartEditInput => ({
  key: 'k',
  name: 'a.docx',
  type: 'x/y',
  account: 'acct',
  source: { kind: 'mail', emailId: 'e1' },
  load: vi.fn(async () => new Uint8Array([9]).buffer),
  ...over,
});

beforeEach(() => {
  policy.decided = true;
  policy.download = true;
  policy.export = true;
  bridge = fakeBridge();
  (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, edit: bridge };
  resetEditSessions();
  setAppLockCheck(null);
});

afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('the policy', () => {
  it('takes both saving attachments and export', () => {
    expect(editAllowed('acct')).toBe(true);
    policy.download = false;
    expect(editAllowed('acct')).toBe(false);
    policy.download = true;
    policy.export = false;
    expect(editAllowed('acct')).toBe(false);
  });

  it('counts an unknown policy as no for starting, and as no reason to delete anything', () => {
    policy.decided = false;
    expect(editAllowed('acct')).toBe(false);
    expect(editForbidden('acct')).toBe(false);
    policy.decided = true;
    policy.export = false;
    expect(editForbidden('acct')).toBe(true);
  });
});

describe('starting', () => {
  it('asks main from the click, then fetches, then opens with what it fetched', async () => {
    const order: string[] = [];
    bridge.begin.mockImplementation(async () => {
      order.push('begin');
      return { ok: true, ticket: 't1' };
    });
    const start = input({ load: async () => {
      order.push('load');
      return new Uint8Array([7, 8]).buffer;
    } });
    bridge.open.mockImplementation(async () => {
      order.push('open');
      return { ok: true, id: 's1' };
    });
    expect(await startAttachmentEdit(start)).toEqual({ ok: true, id: 's1' });
    expect(order).toEqual(['begin', 'load', 'open']);
    const [ticket, file] = bridge.open.mock.calls[0] as unknown as [string, { data: Uint8Array; source: string; account: string; key: string }];
    expect(ticket).toBe('t1');
    expect([...file.data]).toEqual([7, 8]);
    expect(file).toMatchObject({ account: 'acct', key: 'k' });
    expect(JSON.parse(file.source)).toEqual({ kind: 'mail', emailId: 'e1' });
  });

  it('touches nothing when the organisation says no', async () => {
    policy.download = false;
    const start = input();
    expect(await startAttachmentEdit(start)).toEqual({ ok: false, reason: 'policy' });
    expect(bridge.begin).not.toHaveBeenCalled();
    expect(start.load).not.toHaveBeenCalled();
  });

  it('stops when the answer changes while the bytes are on their way, as a guarded sink does', async () => {
    const start = input({ load: async () => {
      policy.export = false;
      return new Uint8Array([1]).buffer;
    } });
    expect(await startAttachmentEdit(start)).toEqual({ ok: false, reason: 'policy' });
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it('stops when the app locks while the bytes are on their way', async () => {
    const start = input({ load: async () => {
      setAppLockCheck(() => true);
      return new Uint8Array([1]).buffer;
    } });
    expect(await startAttachmentEdit(start)).toEqual({ ok: false, reason: 'locked' });
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it('opens the same file again and fetches nothing, so the edits stay', async () => {
    bridge.begin.mockResolvedValue({ ok: true, ticket: 't2', open: 's9' });
    const start = input();
    await startAttachmentEdit(start);
    expect(bridge.reopen).toHaveBeenCalledWith('t2', 's9');
    expect(start.load).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it('passes on what main refuses', async () => {
    bridge.begin.mockResolvedValue({ ok: false, reason: 'locked' });
    const start = input();
    expect(await startAttachmentEdit(start)).toEqual({ ok: false, reason: 'locked' });
    expect(start.load).not.toHaveBeenCalled();
  });

  it('asks the shell which files may go, and answers no without a shell', () => {
    expect(canEditFile('a.docx')).toBe(true);
    expect(canEditFile('a.exe')).toBe(false);
    expect(canEditFile(null)).toBe(false);
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    expect(canEditFile('a.docx')).toBe(false);
  });

  it('does nothing in a browser', async () => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    const start = input();
    expect(await startAttachmentEdit(start)).toEqual({ ok: false, reason: 'unavailable' });
    expect(start.load).not.toHaveBeenCalled();
  });
});

describe('reading a saved file back', () => {
  it('refuses when the organisation has said no since', async () => {
    policy.export = false;
    expect(await readEditedFile({ id: 's1', account: 'acct' })).toEqual({ ok: false, reason: 'policy' });
    expect(bridge.read).not.toHaveBeenCalled();
  });

  it('gives a file that remembers its session and version', async () => {
    const outcome = await readEditedFile({ id: 's1', account: 'acct' });
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.file.name).toBe('a.docx');
    expect(outcome.file.type).toBe('x/y');
    expect(new Uint8Array(await outcome.file.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(editFileInfo(outcome.file)).toEqual({ id: 's1', hash: 'h' });
    expect(editFileInfo(new File([], 'other'))).toBeUndefined();
  });

  it('passes a held or lost file on as such', async () => {
    bridge.read.mockResolvedValueOnce({ ok: false, reason: 'busy' } as never);
    expect(await readEditedFile({ id: 's1', account: 'acct' })).toEqual({ ok: false, reason: 'busy' });
  });
});

describe('a file on its way to a reply', () => {
  it('waits for that message, once', () => {
    const file = new File([], 'a.txt');
    parkFilesForReply('e1', [file]);
    expect(takeFilesForReply('e2')).toEqual([]);
    expect(takeFilesForReply('e1')).toEqual([file]);
    expect(takeFilesForReply('e1')).toEqual([]);
  });

  it('does not wait for ever', () => {
    vi.useFakeTimers();
    try {
      parkFilesForReply('e1', [new File([], 'a.txt')]);
      vi.advanceTimersByTime(3 * 60 * 1000);
      expect(takeFilesForReply('e1')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what main says', () => {
  it('follows the list once per page', async () => {
    const session = { id: 's1', name: 'a', type: '', account: 'x', source: '', changed: true, version: 1, claimed: false };
    bridge.list.mockResolvedValue([session] as never);
    followEditSessions();
    followEditSessions();
    expect(bridge.onChange).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(useEditSessions.getState().sessions).toEqual([session]));
    (bridge.onChange.mock.calls[0] as unknown as [(s: unknown[]) => void])[0]([]);
    expect(useEditSessions.getState().sessions).toEqual([]);
  });
});

describe('where a source came from', () => {
  it('reads what it wrote, and treats anything else as just a file', () => {
    expect(parseEditSource(JSON.stringify({ kind: 'mail', emailId: 'e', ownerAccountId: 'o' }))).toEqual({ kind: 'mail', emailId: 'e', ownerAccountId: 'o' });
    expect(parseEditSource(JSON.stringify({ kind: 'draft', draftId: 'd' }))).toEqual({ kind: 'draft', draftId: 'd' });
    expect(parseEditSource(JSON.stringify({ kind: 'draft', draftId: null }))).toEqual({ kind: 'draft', draftId: null });
    expect(parseEditSource(JSON.stringify({ kind: 'mail' }))).toEqual({ kind: 'file' });
    expect(parseEditSource('not json')).toEqual({ kind: 'file' });
  });
});

describe('the copies go with the account', () => {
  it('on a wipe of an account, and of everything', async () => {
    await runWipeCleaners('acct');
    expect(bridge.clear).toHaveBeenCalledWith('acct');
    bridge.clear.mockClear();
    await runWipeCleaners(null);
    expect(bridge.clear).toHaveBeenCalledWith(null);
  });

  it('at sign-out', async () => {
    await runBeforeSignOut('acct');
    expect(bridge.clear).toHaveBeenCalledWith('acct');
  });

  it("not when the app ended the session itself and keeps the account's data", async () => {
    await runBeforeSignOut('acct', { keepLocalStore: true });
    expect(bridge.clear).not.toHaveBeenCalled();
  });

  it('a cleaner with no shell is no failure', async () => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    await expect(runWipeCleaners(null)).resolves.toBeUndefined();
  });
});
