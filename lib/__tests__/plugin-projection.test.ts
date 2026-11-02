import { describe, it, expect } from 'vitest';
import { contactToView, emailSummary, emailToReadView, eventToView, fileToView, taskToView } from '../plugin-projection';
import type { CalendarEvent, CalendarTask, ContactCard, Email, FileNode } from '../jmap/types';
import { resourceToView, type FileResource } from '@/stores/file-store';

describe('plugin projections', () => {
  it('writes contact dates without a year as --MM-DD', () => {
    const view = contactToView({
      id: 'c1', addressBookIds: { ab: true },
      name: { components: [{ kind: 'given', value: 'Ana' }, { kind: 'surname', value: 'Silva' }] },
      anniversaries: {
        a: { kind: 'birth', date: { '@type': 'PartialDate', month: 2, day: 29 } as never },
        b: { kind: 'wedding', date: { '@type': 'PartialDate', year: 2010, month: 6, day: 5 } as never },
      },
    } as unknown as ContactCard);

    expect(view.fullName).toBe('Ana Silva');
    expect(view.anniversaries).toEqual([
      { kind: 'birth', date: '--02-29' },
      { kind: 'wedding', date: '2010-06-05' },
    ]);
  });

  it('leaves the body out of an email summary', () => {
    const summary = emailSummary({
      id: 'm1', threadId: 't', mailboxIds: { inbox: true, old: false }, keywords: { $seen: true },
      from: [{ email: 'a@x' }], to: [], subject: 'S', receivedAt: 'r', preview: 'p', hasAttachment: false, size: 9,
      bodyValues: { 1: { value: 'secret body' } },
    } as unknown as Email);

    expect(summary.mailboxIds).toEqual(['inbox']);
    expect(JSON.stringify(summary)).not.toContain('secret body');
  });

  it("names the account of a merged view's row, which shares its id with others", () => {
    const row = { id: 'm1', threadId: 't', mailboxIds: {}, keywords: {}, sourceClientAccountId: 'login1', sourceAccountId: 'grp' } as unknown as Email;
    expect(emailSummary(row).accountId).toBe('grp');
    expect(emailToReadView(row).accountId).toBe('grp');
    expect(emailSummary({ ...row, sourceAccountId: undefined })).not.toHaveProperty('accountId');
  });

  it('marks recurring events and completed tasks', () => {
    expect(eventToView({ id: 'e', uid: 'u', calendarIds: { c: true }, recurrenceRules: [{ frequency: 'yearly' }] } as unknown as CalendarEvent).isRecurring).toBe(true);
    expect(taskToView({ id: 't', uid: 'u', calendarIds: {}, progress: 'completed' } as unknown as CalendarTask).isComplete).toBe(true);
  });
});

describe('emailToReadView attachments', () => {
  it('lists attachments with the blob id email.getAttachment takes, and marks inline images', () => {
    const view = emailToReadView({
      id: 'e1', threadId: 't1', mailboxIds: {}, keywords: {}, receivedAt: '2026-10-14T00:00:00Z', hasAttachment: true,
      attachments: [
        { partId: '2', blobId: 'b-pdf', name: 'invoice.pdf', type: 'application/pdf', size: 1234, disposition: 'attachment' },
        { partId: '3', blobId: 'b-img', name: 'logo.png', type: 'image/png', size: 99, cid: 'logo@x' },
        { partId: '4', name: 'broken' },
      ],
    } as never);

    expect(view.attachments).toEqual([
      { blobId: 'b-pdf', name: 'invoice.pdf', type: 'application/pdf', size: 1234, inline: false },
      { blobId: 'b-img', name: 'logo.png', type: 'image/png', size: 99, inline: true, cid: 'logo@x' },
    ]);
  });
});

describe('fileToView', () => {
  // Folder or file by fileNodeKind: Stalwart 1.0's symlinks have no blob
  // but are no folders, and an old blob-backed file marked "d" (#379) is a file.
  it('tells folders from files by the node kind', () => {
    const base = { parentId: null, size: 3, created: '', modified: '2026-01-01T00:00:00Z' };
    const view = (n: Partial<FileNode>) => fileToView({ ...base, id: 'n', name: 'x', type: 'text/plain', blobId: 'b', ...n } as FileNode, '/');
    expect(view({ nodeType: 'symlink', blobId: null, type: '' }).type).toBe('file');
    expect(view({ type: 'd', blobId: 'b-marker' }).type).toBe('file');
    expect(view({ nodeType: 'directory', blobId: null, type: '' })).toMatchObject({ type: 'directory', mimeType: '' });
    // 0.16 before 0.16.6: no nodeType, no blob, a folder.
    expect(view({ blobId: null, type: 'd' }).type).toBe('directory');
    expect(view({}).type).toBe('file');
  });
});

// The Files view's items reach plugins through the same projection: a 1.0
// symlink there has no blob, and was handed to plugins as a folder.
describe('resourceToView', () => {
  it('hands a symlink over as a file, a folder as a folder', () => {
    const base = { id: 'x', parentId: null, name: 'x', contentLength: 0, contentType: '', lastModified: '', blobId: null } as unknown as FileResource;
    expect(resourceToView({ ...base, isDirectory: false, isSymlink: true }, '/').type).toBe('file');
    expect(resourceToView({ ...base, isDirectory: true }, '/').type).toBe('directory');
  });
});
