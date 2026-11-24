import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DESCRIPTION_CHARS, consumePendingEventDraft, eventDraftFromEmail, mailText, savePendingEventDraft,
} from '@/lib/event-from-mail';

// #1579: a new event filled in from a message, for the calendar's editor.

const options = {
  ownEmails: ['Me@example.com'],
  link: 'https://mail.example.com/mail/message/m1',
  linkLine: (link: string) => `Email: ${link}`,
};

describe('eventDraftFromEmail', () => {
  it('takes the subject without its prefixes, the text and a link back to the message', () => {
    const draft = eventDraftFromEmail({
      subject: 'AW: Fwd: Offer for the new roof',
      textBody: [{ partId: '1', type: 'text/plain' }] as never,
      bodyValues: { 1: { value: 'Hello,\n\nwhen can you come by?' } } as never,
    }, options);
    expect(draft.title).toBe('Offer for the new roof');
    expect(draft.description).toBe('Hello,\n\nwhen can you come by?\n\nEmail: https://mail.example.com/mail/message/m1');
    expect(draft.descriptionContentType).toBe('text/plain');
    expect(draft.start).toBeUndefined();
  });

  it('invites the sender and the other recipients, not the user, once each and not Bcc', () => {
    const draft = eventDraftFromEmail({
      from: [{ name: 'Ben', email: 'ben@example.com' }],
      to: [{ name: '', email: 'me@example.com' }, { name: 'Ann', email: 'ann@example.com' }],
      cc: [{ name: 'Ben again', email: 'BEN@example.com' }],
      bcc: [{ name: '', email: 'hidden@example.com' }],
    } as never, options);
    const people = Object.values(draft.participants ?? {});
    expect(people.map((p) => p.email)).toEqual(['ben@example.com', 'ann@example.com']);
    expect(people[0]).toMatchObject({ name: 'Ben', calendarAddress: 'mailto:ben@example.com', roles: { attendee: true }, participationStatus: 'needs-action' });
  });

  it('has no guests when the user wrote to themselves', () => {
    const draft = eventDraftFromEmail({ from: [{ name: '', email: 'me@example.com' }], to: [{ name: '', email: 'me@example.com' }] }, options);
    expect(draft.participants).toBeUndefined();
  });

  it('cuts a long text', () => {
    const draft = eventDraftFromEmail({ preview: 'x'.repeat(MAX_DESCRIPTION_CHARS + 50) }, options);
    expect(draft.description!.startsWith(`${'x'.repeat(MAX_DESCRIPTION_CHARS)}…\n\nEmail:`)).toBe(true);
  });
});

describe('mailText', () => {
  it('reads the HTML body as text when there is no plain one, else the preview', () => {
    expect(mailText({
      htmlBody: [{ partId: 'h', type: 'text/html' }] as never,
      bodyValues: { h: { value: '<p>Meet at <b>10</b></p>' } } as never,
      preview: 'preview',
    })).toBe('Meet at 10');
    expect(mailText({ preview: ' Just the preview ' })).toBe('Just the preview');
  });
});

describe('the draft parked for the calendar', () => {
  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it('is taken once', () => {
    savePendingEventDraft({ title: 'Roof' });
    expect(consumePendingEventDraft()).toEqual({ title: 'Roof' });
    expect(consumePendingEventDraft()).toBeNull();
  });

  it('is dropped once it is old', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    savePendingEventDraft({ title: 'Roof' });
    vi.setSystemTime(new Date('2026-11-24T10:06:00Z'));
    expect(consumePendingEventDraft()).toBeNull();
  });
});
