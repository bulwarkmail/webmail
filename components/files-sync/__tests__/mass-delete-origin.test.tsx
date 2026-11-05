import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/common.json';
import type { FilesSyncController } from '@/lib/files-sync/types';
import { FilesSyncEngine, type EngineTiming } from '@/lib/files-sync/engine';
import { namingFor } from '@/lib/files-sync/names';
import { FakeDisk } from '@/lib/files-sync/__tests__/helpers/fake-disk';
import { FakeServer } from '@/lib/files-sync/__tests__/helpers/fake-server';

// files-p3-1: the engine's mass-delete question, read by both places that ask it (the app-wide
// dialog and the row on the settings page). Deleted on this computer must read "on this
// computer ... in Files too?", deleted in Files the other way round, for a folder and the drive.

vi.unmock('next-intl');

const { useFilesSyncStore } = await import('@/stores/files-sync-store');
const { FilesSyncPrompts, MassDeleteQuestion } = await import('../files-sync-prompts');

const FAST: Partial<EngineTiming> = { localDelayMs: 0, remoteDelayMs: 0, pollMs: 1e9, rescanMs: 1e9, retryMs: [1e9], soonMs: 5, fetchWaitMs: 2000 };

async function engineAsking(drive: boolean, deleteWhere: 'here' | 'files') {
  const server = new FakeServer();
  const disk = new FakeDisk({ caseInsensitive: true, drive });
  const remoteId = drive ? null : server.folder('Sync').id;
  const root = disk.addRoot({ id: 'r1', account: 'a1', kind: drive ? 'drive' : 'folder', remoteId, path: 'C:\\Users\\ann\\Projects', remoteLabel: drive ? 'ann@example.org' : 'Work / Sync' });
  for (let i = 0; i < 60; i += 1) disk.write(root.id, `bulk/f${i}.txt`, `file ${i}`);
  disk.write(root.id, 'other.txt', 'o');
  const engine = new FilesSyncEngine({ controls: disk, naming: namingFor('win32'), device: 'Laptop', readUrl: disk.readUrl, timing: FAST, now: () => disk.clock });
  engine.start();
  engine.setAccount('a1', server.remote());
  const sync = async () => {
    await engine.refreshRoots();
    engine.syncNow();
    await engine.settled();
  };
  await sync();
  if (deleteWhere === 'here') disk.deleteUser(root.id, 'bulk');
  else server.destroyTree(server.find(drive ? 'bulk' : 'Sync/bulk')!.id);
  await sync();
  const status = engine.status().r1;
  engine.stop();
  expect(status.state).toBe('confirm-delete');
  return { root, status };
}

const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>;

afterEach(() => useFilesSyncStore.getState().reset());

describe.each([
  ['a synced folder', false, 'Projects', 'Work / Sync'],
  ['the drive', true, 'Files drive', 'Files drive'],
])('the mass-delete question for %s, as the engine asks it', (_name, drive, localName, remoteName) => {
  it('names this computer when the items were deleted here', async () => {
    const { root, status } = await engineAsking(drive, 'here');
    const text = `61 items were deleted from ${localName} on this computer. Delete them in Files too?`;
    useFilesSyncStore.setState({ available: true, account: 'a1', controller: { confirmMassDelete: vi.fn() } as unknown as FilesSyncController, roots: [root], status: { r1: status } });
    const { unmount } = render(wrap(<FilesSyncPrompts />));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(text);
    unmount();
    render(wrap(<MassDeleteQuestion root={root} status={status} />));
    expect(screen.getByRole('group')).toHaveTextContent(text);
  });

  it('names Files when the items were deleted there', async () => {
    const { root, status } = await engineAsking(drive, 'files');
    const text = `61 items were deleted from ${remoteName} in Files. Delete them on this computer too?`;
    useFilesSyncStore.setState({ available: true, account: 'a1', controller: { confirmMassDelete: vi.fn() } as unknown as FilesSyncController, roots: [root], status: { r1: status } });
    const { unmount } = render(wrap(<FilesSyncPrompts />));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(text);
    unmount();
    render(wrap(<MassDeleteQuestion root={root} status={status} />));
    expect(screen.getByRole('group')).toHaveTextContent(text);
  });
});
