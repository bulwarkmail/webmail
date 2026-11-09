import { describe, expect, it, vi } from 'vitest';
import { findUploadConflicts, resolveConflictsInTurn, type UploadConflict } from '@/lib/files-upload-conflicts';

describe('findUploadConflicts', () => {
  it('lists same-kind clashes once, in upload order', () => {
    const incoming: UploadConflict[] = [
      { name: 'b.txt', kind: 'file' },
      { name: 'Docs', kind: 'folder' },
      { name: 'Docs', kind: 'folder' },
      { name: 'Photos', kind: 'folder' },
      { name: 'new.txt', kind: 'file' },
    ];
    const existing = [
      { name: 'Docs', isDirectory: true },
      { name: 'b.txt', isDirectory: false },
      { name: 'Photos', isDirectory: false },
    ];
    expect(findUploadConflicts(incoming, existing)).toEqual([
      { name: 'b.txt', kind: 'file' },
      { name: 'Docs', kind: 'folder' },
    ]);
  });
});

describe('resolveConflictsInTurn', () => {
  const conflicts: UploadConflict[] = [
    { name: 'a.txt', kind: 'file' },
    { name: 'b.txt', kind: 'file' },
    { name: 'c.txt', kind: 'file' },
  ];

  it('asks one at a time, and "Do this for all" answers the rest', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce({ choice: 'skip', applyToAll: false })
      .mockResolvedValueOnce({ choice: 'replace', applyToAll: true });
    const choices = await resolveConflictsInTurn(conflicts, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls.map((c) => [c[0].name, c[1], c[2]])).toEqual([['a.txt', 0, 3], ['b.txt', 1, 3]]);
    expect([...choices!]).toEqual([['a.txt', 'skip'], ['b.txt', 'replace'], ['c.txt', 'replace']]);
  });

  it('stops when a question is called off', async () => {
    const ask = vi.fn().mockResolvedValueOnce({ choice: 'keep', applyToAll: false }).mockResolvedValueOnce(null);
    expect(await resolveConflictsInTurn(conflicts, ask)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
