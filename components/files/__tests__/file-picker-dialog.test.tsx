import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FilePickerDialog } from '../file-picker-dialog';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));

// Picking files from the Files app for a message (#1179).

function node(id: string, name: string, parentId: string | null, extra: Partial<FileNode> = {}): FileNode {
  const isFolder = extra.blobId === null;
  return {
    id,
    name,
    parentId,
    type: isFolder ? 'd' : 'application/pdf',
    blobId: `blob-${id}`,
    size: isFolder ? 0 : 1000,
    created: '2026-10-01T00:00:00Z',
    modified: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

const TREE: FileNode[] = [
  node('f-docs', 'Documents', null, { blobId: null }),
  node('f-report', 'report.pdf', 'f-docs'),
  node('f-invoice', 'invoice.pdf', null),
  node('f-hidden', '.secret', null),
  node('e:f-plan', 'plan.pdf', null, { isShared: true, accountId: 'e', accountName: 'userb@example.org' }),
];

function clientWith(list: () => Promise<FileNode[]>): IJMAPClient {
  return { listAllFileNodesAcrossAccounts: vi.fn(list) } as unknown as IJMAPClient;
}

function renderPicker(list: () => Promise<FileNode[]> = async () => TREE) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const client = clientWith(list);
  render(<FilePickerDialog client={client} onPick={onPick} onClose={onClose} />);
  return { onPick, onClose, client };
}

describe('FilePickerDialog', () => {
  it('lists the root without hidden or shared nodes, and offers Shared with me', async () => {
    renderPicker();
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('shared_with_me')).toBeInTheDocument();
    expect(screen.queryByText('.secret')).toBeNull();
    expect(screen.queryByText('plan.pdf')).toBeNull();
  });

  it('keeps the selection while browsing folders and hands back the picked nodes', async () => {
    const { onPick } = renderPicker();
    fireEvent.click(await screen.findByText('invoice.pdf'));
    fireEvent.click(screen.getByText('Documents'));
    fireEvent.click(await screen.findByText('report.pdf'));
    fireEvent.click(screen.getByText('breadcrumb_root'));
    fireEvent.click(screen.getByText('shared_with_me'));
    fireEvent.click(await screen.findByText('plan.pdf'));

    fireEvent.click(screen.getByTestId('file-picker-attach'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].map((n: FileNode) => n.id)).toEqual(['f-invoice', 'f-report', 'e:f-plan']);
  });

  it('unselects a file on a second click and only enables Attach with a selection', async () => {
    renderPicker();
    const attach = screen.getByTestId('file-picker-attach');
    expect(attach).toBeDisabled();
    const row = (await screen.findByText('invoice.pdf')).closest('button')!;
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(attach).toBeEnabled();
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-checked', 'false');
    expect(attach).toBeDisabled();
  });

  it('searches files in every folder and shows where each one lives', async () => {
    renderPicker();
    await screen.findByText('invoice.pdf');
    fireEvent.change(screen.getByPlaceholderText('search_placeholder'), { target: { value: 'RE' } });
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.queryByText('invoice.pdf')).toBeNull();
  });

  it('offers a retry when the listing fails', async () => {
    let calls = 0;
    renderPicker(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return TREE;
    });
    fireEvent.click(await screen.findByText('retry'));
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();
  });
});
