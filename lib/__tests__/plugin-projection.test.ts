import { describe, it, expect } from 'vitest';
import { contactToView, emailSummary, emailToReadView, eventToView, taskToView } from '../plugin-projection';
import type { CalendarEvent, CalendarTask, ContactCard, Email } from '../jmap/types';

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
      { blobId: 'b-img', name: 'logo.png', type: 'image/png', size: 99, inline: true },
    ]);
  });
});
