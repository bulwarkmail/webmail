/**
 * The demo data is what every screenshot and the public demo show. These
 * tests pin the facts the drivers and the viewer rely on: ids resolve, the
 * files behind attachments exist with the recorded sizes, and the fixtures
 * trigger the features they are written for (mention chips, the invitation
 * banner, the verification-code chip, the sender-authentication warning,
 * unsubscribe, read receipts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getDemoData } from '../demo-data';
import { DemoJMAPClient } from '../demo-client';
import { DEMO_ASSETS } from '../fixtures/assets';
import { PORTRAITS, NORA, NORA_PERSONAL, ALICE, BOB, PRIYA } from '../fixtures/people';
import { GONOGO_INVITE_BLOB, GONOGO_UID } from '../fixtures/emails';
import { GONOGO_EVENT_ID, createGoNoGoInvitationIcs } from '../fixtures/calendars';
import { SUPPORT_ACCOUNT_ID, SMB, MB } from '../fixtures/mailboxes';
import { DEMO_KEYWORDS } from '../fixtures/keywords';
import { getSenderVerification, extractListHeaders } from '@/lib/email-headers';
import { findVerificationCode } from '@/lib/verification-code';
import { findCalendarAttachment } from '@/lib/calendar-invitation';
import { mentionFromLink } from '@/lib/recipient-mentions';
import { KEYWORD_PALETTE, useSettingsStore } from '@/stores/settings-store';
import { seedDemoPreferences, DEMO_SEED_KEY } from '../demo-preferences';
import { PRINCIPAL } from '../fixtures/directory';
import { confirmGroups } from '@/lib/plugin-sandbox/account-kind';
import { summarizeDelegates } from '@/lib/delegation/delegation';
import { MAILBOX_PRESETS } from '@/lib/jmap/share-rights';
import { principalLabel, shareRecipientNames } from '@/hooks/use-share-recipient-labels';
import { checkAvailabilityAccess, lookUpAvailability } from '@/lib/jmap/free-busy';
import { availabilityFor } from '@/components/calendar/participant-availability';
import { demoAt, demoISODate } from '../demo-utils';
import type { BusyPeriod } from '@/lib/jmap/types';
import { useRecoveryStore } from '@/stores/recovery-store';
import { SUPPORT_TAGS } from '../fixtures/shared-metadata';
import { SIGNED_EMAIL_ID, SIGNED_TEXT } from '../fixtures/signed';
import { INVOICE_BLOB, INVOICE_FILE, INVOICE_TOTAL, createSpreehostInvoiceXml } from '../fixtures/invoice';
import { INVOICE_EMAIL_ID } from '../fixtures/supplier';
import { FLIGHT_DAY, FLIGHT_EMAIL_ID, FLIGHT_REFERENCE, FLIGHT_SENDER, createFlightReservation } from '../fixtures/travel';
import { getStructuredMailTrust, structuredHtmlPart } from '@/lib/structured-mail/trust';
import { loadAirportZones, readStructuredMailDetailed, resolveCards } from '@/lib/structured-mail';
import { loadSharedTags, sharedTagsKey, useSharedTagsStore, saveSharedTags } from '@/stores/shared-tags-store';

const PUBLIC = path.resolve(__dirname, '..', '..', '..', 'public');
const work = getDemoData('work');
const personal = getDemoData('personal');

function allMailboxIds(data: ReturnType<typeof getDemoData>): Set<string> {
  const ids = data.mailboxes.map((m) => m.id);
  for (const shared of Object.values(data.sharedMailboxes)) ids.push(...shared.mailboxes.map((m) => m.id));
  return new Set(ids);
}

describe('demo fixtures: structure', () => {
  it.each([['work', work], ['personal', personal]] as const)('%s mail only uses folders that exist and has unique ids', (_name, data) => {
    const mailboxIds = allMailboxIds(data);
    const seenIds = new Set<string>();
    const seenMessageIds = new Set<string>();
    for (const email of data.emails) {
      expect(seenIds.has(email.id), `duplicate id ${email.id}`).toBe(false);
      seenIds.add(email.id);
      expect(seenMessageIds.has(email.messageId!), `duplicate Message-ID ${email.messageId}`).toBe(false);
      seenMessageIds.add(email.messageId!);
      for (const mailboxId of Object.keys(email.mailboxIds)) {
        expect(mailboxIds.has(mailboxId), `${email.id} is filed in unknown folder ${mailboxId}`).toBe(true);
      }
    }
  });

  it('reply chains point at messages that exist', () => {
    const known = new Set([...work.emails, ...personal.emails].map((e) => e.messageId));
    for (const email of [...work.emails, ...personal.emails]) {
      for (const ref of [...(email.inReplyTo ?? []), ...(email.references ?? [])]) {
        expect(known.has(ref), `${email.id} references ${ref}`).toBe(true);
      }
    }
  });

  it('every thread with several messages shares one subject stem', () => {
    const byThread = new Map<string, typeof work.emails>();
    for (const e of [...work.emails, ...personal.emails]) byThread.set(e.threadId, [...(byThread.get(e.threadId) ?? []), e]);
    for (const [threadId, emails] of byThread) {
      if (emails.length < 2) continue;
      const stems = new Set(emails.map((e) => (e.subject ?? '').replace(/^(re|fwd?):\s*/i, '').toLowerCase()));
      expect(stems.size, `thread ${threadId} mixes subjects ${[...stems].join(' | ')}`).toBe(1);
    }
  });

  it('nothing in an inbox is dated in the future', () => {
    const now = Date.now();
    for (const e of [...work.emails, ...personal.emails]) {
      expect(new Date(e.receivedAt).getTime(), `${e.id} is in the future`).toBeLessThanOrEqual(now);
    }
  });

  it('the inbox is busy enough to scroll and about a third unread', () => {
    const inbox = work.emails.filter((e) => e.mailboxIds[MB.inbox]);
    expect(inbox.length).toBeGreaterThanOrEqual(35);
    const unread = inbox.filter((e) => !e.keywords.$seen).length / inbox.length;
    expect(unread).toBeGreaterThan(0.25);
    expect(unread).toBeLessThan(0.5);
  });

  it('every tag on a message has a definition with a palette colour', () => {
    // Nora's own tags on her mail; the Support team's shared tags on Support mail.
    const isSupport = (e: (typeof work.emails)[number]) => Object.keys(e.mailboxIds).some((id) => id.startsWith('demo-support-'));
    const own = [...work.emails.filter((e) => !isSupport(e)), ...personal.emails];
    const team = work.emails.filter(isSupport);
    for (const [definitions, emails] of [[DEMO_KEYWORDS, own], [SUPPORT_TAGS, team]] as const) {
      const defined = new Set(definitions.map((k) => `$label:${k.id}`));
      for (const k of definitions) expect(KEYWORD_PALETTE[k.color], `colour ${k.color}`).toBeDefined();
      for (const e of emails) {
        for (const keyword of Object.keys(e.keywords)) {
          if (keyword.startsWith('$label:')) expect(defined.has(keyword), `${e.id} carries undefined tag ${keyword}`).toBe(true);
        }
      }
      // The sidebar should have something to count for each tag.
      for (const tag of defined) expect(emails.some((e) => e.keywords[tag]), `${tag} is never used`).toBe(true);
    }
  });

  it('calendar items and files point at calendars and assets that exist', () => {
    const calendars = new Set(work.calendars.map((c) => c.id));
    for (const ev of work.calendarEvents) for (const id of Object.keys(ev.calendarIds)) expect(calendars.has(id), ev.id).toBe(true);
    for (const t of work.calendarTasks) for (const id of Object.keys(t.calendarIds)) expect(calendars.has(id), t.id).toBe(true);
    for (const node of work.fileNodes) {
      if (node.blobId) expect(DEMO_ASSETS[node.blobId as keyof typeof DEMO_ASSETS], `${node.name} -> ${node.blobId}`).toBeDefined();
      if (node.parentId) expect(work.fileNodes.some((n) => n.id === node.parentId), `${node.name} parent`).toBe(true);
    }
  });

  it.each([['work', work], ['personal', personal]] as const)('%s contact groups only list contacts that exist', (_name, data) => {
    const ids = new Set(data.contacts.map((c) => c.id));
    expect(ids.size, 'duplicate contact ids').toBe(data.contacts.length);
    for (const group of data.contacts.filter((c) => c.kind === 'group')) {
      for (const member of Object.keys(group.members ?? {})) expect(ids.has(member), `${group.id} -> ${member}`).toBe(true);
    }
    expect(data.contacts.filter((c) => c.kind === 'group').length).toBeGreaterThanOrEqual(2);
  });

  it('people who write to Nora from the cast are in her address books', () => {
    const contactEmails = new Set(work.contacts.flatMap((c) => Object.values(c.emails ?? {}).map((e) => e.address.toLowerCase())));
    for (const p of PORTRAITS) {
      if (p.email === NORA.email) continue;
      expect(contactEmails.has(p.email.toLowerCase()), `${p.name} has a portrait but no contact card`).toBe(true);
    }
  });

  it('the personal login has the photo of everyone who writes to it, and of Nora on both addresses', () => {
    // Avatars only look at the open account's cards.
    const photoOf = (address: string) => personal.contacts
      .find((c) => Object.values(c.emails ?? {}).some((e) => e.address === address))
      ?.media?.photo1?.uri;
    const senders = new Set(personal.emails.flatMap((e) => e.from ?? []).map((a) => a.email));
    const cast = PORTRAITS.filter((p) => senders.has(p.email));
    expect(cast.length).toBeGreaterThanOrEqual(5);
    for (const p of cast) expect(photoOf(p.email), p.name).toBe(`/demo/portraits/${p.portrait}.jpg`);
    expect(photoOf(NORA_PERSONAL.email)).toBe('/demo/portraits/nora-lindqvist.jpg');
    expect(photoOf(NORA.email)).toBe('/demo/portraits/nora-lindqvist.jpg');
  });
});

describe('demo fixtures: files behind the data', () => {
  it('every asset exists in public/demo with the recorded size', () => {
    for (const [blobId, asset] of Object.entries(DEMO_ASSETS)) {
      const file = path.join(PUBLIC, asset.path);
      expect(fs.existsSync(file), `${blobId}: ${asset.path} missing`).toBe(true);
      expect(fs.statSync(file).size, `${asset.path} size changed; update fixtures/assets.ts`).toBe(asset.size);
    }
  });

  it('every attachment is backed by an asset', () => {
    for (const e of [...work.emails, ...personal.emails]) {
      for (const att of e.attachments ?? []) {
        if (att.blobId === GONOGO_INVITE_BLOB || att.blobId === INVOICE_BLOB) continue;
        expect(DEMO_ASSETS[att.blobId as keyof typeof DEMO_ASSETS], `${e.id} -> ${att.name}`).toBeDefined();
      }
    }
  });

  it('every portrait exists and is small', () => {
    for (const p of PORTRAITS) {
      const file = path.join(PUBLIC, 'demo', 'portraits', `${p.portrait}.jpg`);
      expect(fs.existsSync(file), `${p.name}: ${file}`).toBe(true);
      expect(fs.statSync(file).size).toBeLessThan(30_000);
    }
  });

  it('contact photos are served locally, not from a third party', () => {
    for (const c of [...work.contacts, ...personal.contacts]) {
      for (const m of Object.values(c.media ?? {})) expect(m.uri).toMatch(/^\/demo\/portraits\//);
    }
  });
});

describe('demo fixtures: features the screenshots show', () => {
  const client = new DemoJMAPClient('work');

  it('derives sender authentication from the headers: legit mail passes, the phishing mail fails', async () => {
    const legit = (await client.getEmail('demo-email-sarah-invoice'))!;
    expect(legit.authenticationResults?.dmarc?.result).toBe('pass');
    expect(getSenderVerification(legit.authenticationResults, legit.from![0].email)).toBeNull();

    const phish = (await client.getEmail('demo-email-spam-phish'))!;
    expect(getSenderVerification(phish.authenticationResults, phish.from![0].email)?.status).toBe('failed');
    expect(phish.spamScore).toBeGreaterThan(5);
    expect(phish.spamLLM?.verdict).toBe('SPAM');
  });

  it('newsletters carry a one-click unsubscribe the viewer can act on', async () => {
    const nl = (await client.getEmail('demo-email-techdigest'))!;
    const list = extractListHeaders(nl.headers!);
    expect(list.listUnsubscribe?.http).toMatch(/^https:\/\//);
    expect(list.listUnsubscribe?.mailto).toContain('@');
    expect(list.listUnsubscribe?.preferred).toBe('http');
  });

  it('the launch plan asks for a read receipt', async () => {
    const e = (await client.getEmail('demo-email-launch-plan'))!;
    expect(e.headers?.['Disposition-Notification-To']).toContain('michael.torres@');
  });

  it('the GitHub mail shows a verification-code chip', async () => {
    const e = (await client.getEmail('demo-email-github-code'))!;
    expect(findVerificationCode(e.subject, e.preview)).toBe('482913');
    expect(Date.now() - new Date(e.receivedAt).getTime()).toBeLessThan(60 * 60 * 1000);
  });

  it('Alice mentions Nora and Bob with links the viewer turns into chips', async () => {
    const e = (await client.getEmail('demo-email-rollback-1'))!;
    const html = e.bodyValues![e.htmlBody![0].partId].value;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const mentions = [...doc.querySelectorAll('a')].map((a) => mentionFromLink(a as HTMLElement)).filter(Boolean);
    expect(mentions).toEqual([
      { label: 'Nora', email: NORA.email },
      { label: 'Bob', email: BOB.email },
    ]);
  });

  it('the go/no-go mail is an invitation Nora can answer', async () => {
    const e = (await client.getEmail('demo-email-gonogo-invite'))!;
    const att = findCalendarAttachment(e);
    expect(att?.blobId).toBe(GONOGO_INVITE_BLOB);

    const ics = createGoNoGoInvitationIcs();
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain(`UID:${GONOGO_UID}`);
    expect(await (await client.fetchBlob(GONOGO_INVITE_BLOB)).text()).toBe(ics);

    const [parsed] = await client.parseCalendarEvents('demo-account', GONOGO_INVITE_BLOB);
    expect(parsed.uid).toBe(GONOGO_UID);
    const me = Object.values(parsed.participants!).find((p) => p.email === NORA.email)!;
    expect(me.participationStatus).toBe('needs-action');
    expect(Object.values(parsed.participants!).some((p) => p.roles.owner && p.email === ALICE.email)).toBe(true);
    // The event is already on the calendar, waiting for the answer.
    expect((await client.queryCalendarEvents({ uid: GONOGO_UID }))[0]?.id).toBe(GONOGO_EVENT_ID);
  });

  it('an RSVP arrives as a JSON-pointer patch and lands on the participant', async () => {
    const fresh = new DemoJMAPClient('work');
    const event = (await fresh.getCalendarEvent(GONOGO_EVENT_ID))!;
    const [key] = Object.entries(event.participants!).find(([, p]) => p.email === NORA.email)!;
    await fresh.updateCalendarEvent(GONOGO_EVENT_ID, { [`participants/${key}/participationStatus`]: 'accepted' } as never);
    expect((await fresh.getCalendarEvent(GONOGO_EVENT_ID))!.participants![key].participationStatus).toBe('accepted');
    expect(Object.keys((await fresh.getCalendarEvent(GONOGO_EVENT_ID))!)).not.toContain(`participants/${key}/participationStatus`);
  });

  it('the Support mailbox is listed as a shared account next to the work folders', async () => {
    const all = await client.getAllMailboxes();
    const shared = all.filter((m) => m.isShared);
    expect(shared.map((m) => m.id)).toContain(`${SUPPORT_ACCOUNT_ID}:${SMB.inbox}`);
    expect(shared.every((m) => m.accountId === SUPPORT_ACCOUNT_ID && m.accountName === 'Support')).toBe(true);
    const inbox = shared.find((m) => m.originalId === SMB.inbox)!;
    expect(inbox.unreadEmails).toBeGreaterThan(0);
    // Queried the way the store does it: by the bare id and the owner account.
    const { emails } = await client.getEmails(SMB.inbox, SUPPORT_ACCOUNT_ID);
    expect(emails.length).toBe(inbox.totalEmails);
    expect(client.getSharedAccounts().map((a) => a.id)).toEqual(['demo-account', SUPPORT_ACCOUNT_ID]);
  });

  it('folder counts come from the mail, including nested folders', async () => {
    const mailboxes = await client.getMailboxes();
    for (const mb of mailboxes) {
      const inFolder = work.emails.filter((e) => e.mailboxIds[mb.id]);
      expect(mb.totalEmails, mb.name).toBe(inFolder.length);
      expect(mb.unreadEmails, mb.name).toBe(inFolder.filter((e) => !e.keywords.$seen).length);
    }
    expect(mailboxes.find((m) => m.id === MB.beacon)?.parentId).toBe(MB.projects);
    expect(mailboxes.find((m) => m.id === MB.archive2025)?.parentId).toBe(MB.archive);
  });

  it('the personal account is a separate login with mail and contacts', async () => {
    const second = new DemoJMAPClient('personal');
    expect(second.getAccountId()).not.toBe(client.getAccountId());
    expect(second.getUsername()).not.toBe(client.getUsername());
    expect(second.supportsCalendars()).toBe(false);
    expect(second.supportsContacts()).toBe(true);
    expect(second.supportsFiles()).toBe(false);
    expect((await second.getMailboxes()).find((m) => m.role === 'inbox')?.unreadEmails).toBeGreaterThan(0);
  });

  it('"recent mail" on a contact card finds mail to and from that person', async () => {
    const { emails } = await client.advancedSearchEmails({ operator: 'OR', conditions: [{ from: ALICE.email }, { to: ALICE.email }] });
    expect(emails.length).toBeGreaterThan(2);
    expect(emails.every((e) => [...(e.from ?? []), ...(e.to ?? [])].some((a) => a.email === ALICE.email))).toBe(true);
  });

  it('a scheduled message is waiting in Drafts', async () => {
    const { emails } = await client.getScheduledEmails();
    expect(emails.map((e) => e.id)).toContain('demo-email-scheduled-prep');
    expect(new Date(emails[0].scheduledSendAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('demo fixtures: calendar times', () => {
  it('utcStart matches the local wall-clock start of every timed event', () => {
    for (const ev of work.calendarEvents) {
      if (ev.showWithoutTime || !ev.utcStart) continue;
      const local = new Date(ev.start);
      expect(new Date(ev.utcStart).getTime(), `${ev.title}: ${ev.start} vs ${ev.utcStart}`).toBe(local.getTime());
    }
  });

  it('a quarter-hour standup lasts fifteen minutes', () => {
    const standup = work.calendarEvents.find((e) => e.id === 'demo-event-standup')!;
    expect(standup.duration).toBe('PT15M');
    expect(new Date(standup.utcEnd!).getTime() - new Date(standup.utcStart!).getTime()).toBe(15 * 60 * 1000);
  });
});

describe('demo client: account scope', () => {
  it('a query for the shared Support account returns only its mail, and the primary account never returns it', async () => {
    const client = new DemoJMAPClient('work');
    const support = await client.searchEmails('Beacon', undefined, SUPPORT_ACCOUNT_ID);
    expect(support.emails.length).toBeGreaterThan(0);
    expect(support.emails.every((e) => Object.keys(e.mailboxIds).some((id) => id.startsWith('demo-support-')))).toBe(true);
    const own = await client.searchEmails('Beacon');
    expect(own.emails.some((e) => Object.keys(e.mailboxIds).some((id) => id.startsWith('demo-support-')))).toBe(false);
    // The two scopes together cover every match exactly once.
    const all = [...own.emails, ...support.emails].map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
    const { emails: inbox } = await client.getEmails(undefined, SUPPORT_ACCOUNT_ID);
    expect(inbox.every((e) => Object.keys(e.mailboxIds).some((id) => id.startsWith('demo-support-')))).toBe(true);
  });
});

// What the website's audience screenshots show in action
// (local-data/website-audiences-plan.md, section 8).
describe('demo fixtures: audience screenshots', () => {
  it('a returning visitor gets Nora\'s details for the organisation signature', () => {
    // Seeded with the previous version: the new details must still arrive.
    localStorage.setItem(DEMO_SEED_KEY, '2026-10');
    seedDemoPreferences();
    expect(useSettingsStore.getState().signatureDetails).toEqual({
      title: 'Engineering Lead', department: 'Platform', phone: '+49 30 555 0199', mobile: '',
    });
  });

  it('the out-of-office reply is filled in for the Lisbon days on the calendar, and off', async () => {
    const reply = await new DemoJMAPClient('work').getVacationResponse();
    // Switched on, the sidebar would say so in every screenshot; the
    // out-of-office flow turns it on itself.
    expect(reply.isEnabled).toBe(false);
    expect(reply.subject).toBe('Out of office: back next week');
    expect(reply.htmlBody).toContain('Lisbon');
    const trip = work.calendarEvents.find((e) => e.id === 'demo-event-lisbon')!;
    const from = new Date(reply.fromDate!).getTime();
    const to = new Date(reply.toDate!).getTime();
    expect(from).toBeLessThan(to);
    expect(from).toBeGreaterThanOrEqual(new Date(trip.utcStart!).getTime());
    expect(to).toBeLessThanOrEqual(new Date(trip.utcEnd!).getTime());
    expect(reply.textBody).toContain('Lisbon');
  });

  it('the server confirms the Support mailbox as a group, the way plugins and shared tags ask', async () => {
    const client = new DemoJMAPClient('work');
    expect(client.supportsPrincipals()).toBe(true);
    expect(await client.getPrincipalTypes([SUPPORT_ACCOUNT_ID, PRINCIPAL.alice])).toEqual({ [SUPPORT_ACCOUNT_ID]: 'group', [PRINCIPAL.alice]: 'individual' });
    expect([...await confirmGroups(client)]).toEqual([SUPPORT_ACCOUNT_ID]);
    // Nora's principal is her own account, so she is never her own delegate.
    expect(PRINCIPAL.nora).toBe(client.getAccountId());
  });

  it('the directory lists the Meridian colleagues and finds them by address', async () => {
    const client = new DemoJMAPClient('work');
    const { principals, status } = await client.listPrincipals();
    expect(status).toBe('ok');
    for (const person of [ALICE, BOB, PRIYA]) expect(principals.some((p) => p.email === person.email && p.type === 'individual'), person.name).toBe(true);
    expect((await client.findPrincipalByEmail(` ${ALICE.email.toUpperCase()} `)).principal?.id).toBe(PRINCIPAL.alice);
    expect((await client.findPrincipalByEmail('tomas.ferreira@lumenlogistics.example')).principal).toBeNull();
    expect(new DemoJMAPClient('personal').supportsPrincipals()).toBe(false);
  });

  it('Settings > Sharing lists Alice with read access to the Inbox, and a new grant sticks', async () => {
    const client = new DemoJMAPClient('work');
    // The gate in components/settings/settings-app.tsx.
    expect(!!client.getShareTargets && client.supportsPrincipals() && client.supportsMailboxSharing()).toBe(true);
    const { targets, failed } = await client.getShareTargets();
    expect(failed).toEqual([]);
    const [alice, ...others] = summarizeDelegates(targets, [client.getAccountId()]);
    expect(others).toEqual([]);
    expect(alice.principalId).toBe(PRINCIPAL.alice);
    expect(alice.level).toBe('read');
    expect(alice.mail).toMatchObject({ shared: 1, inbox: true });

    const sent = targets.find((t) => t.kind === 'mailbox' && t.role === 'sent')!;
    const [result] = await client.applyShareChanges([{ kind: 'mailbox', accountId: sent.accountId, id: sent.id, name: sent.name, principalId: PRINCIPAL.bob, rights: MAILBOX_PRESETS.read }]);
    expect(result.ok).toBe(true);
    expect(await client.getMailboxShareWith(sent.id)).toEqual({ [PRINCIPAL.bob]: MAILBOX_PRESETS.read });
    await client.setMailboxShare(sent.id, PRINCIPAL.bob, null);
    expect(await client.getMailboxShareWith(sent.id)).toBeNull();
  });

  it('the calendar list has Alice\'s Beacon team calendar under her name, and Work shared with her', async () => {
    const client = new DemoJMAPClient('work');
    const calendars = await client.getAllCalendars();
    const team = calendars.find((c) => c.name === 'Beacon team')!;
    expect(team).toMatchObject({ isShared: true, accountId: PRINCIPAL.alice, accountName: ALICE.name });
    expect(work.calendarEvents.some((e) => e.calendarIds[team.id])).toBe(true);

    const own = calendars.find((c) => c.name === 'Work')!;
    expect(own.isShared).toBeFalsy();
    const labels = new Map((await client.getPrincipals()).map((p) => [p.id, principalLabel(p)]));
    expect(shareRecipientNames(own.shareWith, labels)).toEqual([`${ALICE.email} (${ALICE.name})`]);
    const [alice] = summarizeDelegates((await client.getShareTargets()).targets, [client.getAccountId()]);
    expect(alice.calendars.shared).toBe(1);
  });

  it('inviting Alice, Bob and Priya shows their free/busy: busy, free and tentative at 11:00 today', async () => {
    const client = new DemoJMAPClient('work');
    // The gate in components/calendar/participant-availability.tsx.
    expect(!!client.supportsAvailability?.() && !!client.getPrincipalsAvailability).toBe(true);
    expect(await checkAvailabilityAccess(client)).toBe(true);
    const ids = [PRINCIPAL.alice, PRINCIPAL.bob, PRINCIPAL.priya];
    // Every day of the demo's working week has something, so no one shows "No busy times".
    for (const day of [0, 1, 2, 3]) {
      const answers = await lookUpAvailability(client, ids, new Date(demoAt(day, 9)), new Date(demoAt(day, 10)));
      for (const id of ids) {
        const answer = answers[id];
        expect('periods' in answer && answer.periods.length > 0, `${id} on day ${day}`).toBe(true);
      }
    }
    const start = new Date(demoAt(0, 11));
    const end = new Date(demoAt(0, 12));
    const answers = await client.getPrincipalsAvailability!(ids, new Date(demoAt(0, 0)), new Date(demoAt(1, 0)));
    const status = (id: string) => availabilityFor((answers[id] as { periods: BusyPeriod[] }).periods, start, end);
    expect([status(PRINCIPAL.alice), status(PRINCIPAL.bob), status(PRINCIPAL.priya)]).toEqual(['busy', 'free', 'tentative']);
    // The team meetings on the calendar count too: everyone is in the Beacon weekly at 10:00.
    const weekly = (id: string) => availabilityFor((answers[id] as { periods: BusyPeriod[] }).periods, new Date(demoAt(0, 10)), new Date(demoAt(0, 11)));
    expect(ids.map(weekly)).toEqual(['busy', 'busy', 'busy']);
  });

  it('Recover deleted items lists four deleted messages, newest first, and puts one back in the Inbox', async () => {
    const client = new DemoJMAPClient('work');
    // What stores/recovery-store.ts asks before Settings shows the page.
    expect(await useRecoveryStore.getState().detect(client, 'fixture-test|demo-account', { force: true })).toBe(true);
    expect(await client.hasArchivedEmail!(undefined, { days: 30 })).toBe(true);
    const { items, nextPosition } = await client.listArchivedEmails!(undefined, { days: 30 });
    expect(nextPosition).toBeNull();
    expect(items.map((i) => i.subject)).toEqual([
      'Beacon budget v2: infra line items',
      'Canary tenants: final list',
      'Infra Weekly #212: rollbacks, retries and one very long postmortem',
      'Launch post: first draft',
    ]);
    expect(items[0]).toMatchObject({ fromName: PRIYA.name, fromEmail: PRIYA.email, accountId: client.getAccountId() });
    // None of them is still in a folder.
    const known = new Set(work.emails.map((e) => e.messageId));
    for (const item of items) expect(known.has(`<${item.id.replace('archived-', '')}@meridianlabs.example>`), item.subject).toBe(false);

    const [result] = await client.restoreArchivedItems!([items[0].id]);
    expect(result.ok).toBe(true);
    const { emails } = await client.getEmails(MB.inbox);
    const back = emails.find((e) => e.subject === items[0].subject)!;
    expect(back).toBeDefined();
    expect(back.keywords).toEqual({});
    expect((await client.listArchivedEmails!(undefined, { days: 30 })).items).toHaveLength(3);
    expect((await client.restoreArchivedItems!([items[0].id]))[0]).toMatchObject({ ok: false, type: 'notFound' });
    expect(new DemoJMAPClient('personal').advertisesArchivedItems!()).toBe(false);
  });

  it('the Support mailbox shows the team\'s shared tags, and a member\'s change is kept', async () => {
    const client = new DemoJMAPClient('work');
    const key = sharedTagsKey('fixture-test', SUPPORT_ACCOUNT_ID);
    await loadSharedTags(key, SUPPORT_ACCOUNT_ID, client);
    const entry = useSharedTagsStore.getState().entries[key];
    expect(entry.status).toBe('ready');
    expect(entry.tags.map((t) => `${t.label}:${t.color}`)).toEqual(['Accounts:orange', 'Billing:green', 'Bug:red', 'Integration:purple']);
    expect(entry.discovered).toMatchObject({ '$label:billing': 2, '$label:integration': 3 });

    await saveSharedTags(key, SUPPORT_ACCOUNT_ID, client, [{ id: 'bug', value: { label: 'Bug report', color: 'red' } }]);
    const stored = await client.getBulwarkMetadata!(SUPPORT_ACCOUNT_ID);
    expect((stored!.tags as { tags: Record<string, { label: string }> }).tags.bug.label).toBe('Bug report');
    expect((stored!.tags as { tags: Record<string, unknown> }).tags.billing).toBeDefined();

    // Nora's own account keeps none (her templates stay on the device), and its tags don't mix with the team's.
    expect(client.supportsBulwarkMetadata!(client.getAccountId())).toBe(false);
    const own = await client.discoverKeywords();
    expect(Object.keys(own.keywords).some((k) => SUPPORT_TAGS.some((t) => k === `$label:${t.id}`))).toBe(false);
  });

  it('the team inbox plugin finds Support mail assigned to Nora and to Bob, one thread done, and their names', async () => {
    const client = new DemoJMAPClient('work');
    // The plugin's "Assigned to me" filter: `$assigned:` plus the user's account id (user.getSelf).
    const mine = await client.getEmails(SMB.inbox, SUPPORT_ACCOUNT_ID, 50, 0, `$assigned:${client.getAccountId()}`);
    expect(mine.emails.map((e) => e.id).sort()).toEqual(['demo-support-tomas', 'demo-support-yusuf-2']);
    const bobs = await client.getEmails(SMB.inbox, SUPPORT_ACCOUNT_ID, 50, 0, `$assigned:${PRINCIPAL.bob}`);
    expect(bobs.emails.map((e) => e.id)).toEqual(['demo-support-lena-reset']);
    // "Open" is everything not $done.
    const open = await client.getEmails(SMB.inbox, SUPPORT_ACCOUNT_ID, 50, 0, undefined, false, { notKeyword: '$done' });
    const all = await client.getEmails(SMB.inbox, SUPPORT_ACCOUNT_ID);
    expect(all.total - open.total).toBe(1);
    // Keywords the plugin can write: lowercase ids that fit its rule.
    for (const e of all.emails) {
      for (const k of Object.keys(e.keywords).filter((k) => k.startsWith('$assigned:'))) expect(k).toMatch(/^\$assigned:[a-z0-9][a-z0-9_.-]{0,100}$/);
    }
    // Names for the badges: the group's shared map (plugin.team-inbox) and the directory.
    const names = (await client.getBulwarkMetadata!(SUPPORT_ACCOUNT_ID))!['plugin.team-inbox'] as { people: Record<string, { n: string }> };
    expect(names.people[PRINCIPAL.bob].n).toBe(BOB.name);
    expect((await client.getPrincipals()).find((p) => p.id === PRINCIPAL.bob)?.email).toBe(BOB.email);
  });

  it('Alice\'s S/MIME signed mail is multipart/signed with smime.p7s, and the raw message behind it matches', async () => {
    const client = new DemoJMAPClient('work');
    const email = (await client.getEmail(SIGNED_EMAIL_ID))!;
    expect(email.from?.[0].email).toBe(ALICE.email);
    expect(email.headers?.['Content-Type']).toMatch(/^multipart\/signed;.*protocol="application\/pkcs7-signature"/);
    expect(email.bodyStructure?.type).toBe('multipart/signed');
    const sigPart = email.bodyStructure?.subParts?.find((p) => p.type === 'application/pkcs7-signature');
    expect(sigPart?.name).toBe('smime.p7s');
    expect(email.attachments?.map((a) => a.name)).toEqual(['smime.p7s']);

    // The plugin verifies the raw message the blobId names.
    const asset = DEMO_ASSETS[email.blobId as keyof typeof DEMO_ASSETS];
    expect(asset?.path).toBe('/demo/beacon-security-signoff.eml');
    const eml = fs.readFileSync(path.join(PUBLIC, asset.path)).toString('latin1');
    expect(eml).toContain(`From: Alice Johnson <${ALICE.email}>`);
    const boundary = /boundary="([^"]+)"/.exec(eml)![1];
    const [, entity, signaturePart] = eml.split(`--${boundary}`);
    // The signed text is the text the viewer shows.
    expect(entity.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '\n').trim()).toBe(SIGNED_TEXT.trim());
    // And its smime.p7s is the attachment's file, byte for byte.
    const der = Buffer.from(signaturePart.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64');
    expect(der.equals(fs.readFileSync(path.join(PUBLIC, DEMO_ASSETS[sigPart!.blobId as keyof typeof DEMO_ASSETS].path)))).toBe(true);
  });

  it('Spreehost\'s invoice mail carries an XRechnung that adds up and is not overdue', async () => {
    const client = new DemoJMAPClient('work');
    const email = (await client.getEmail(INVOICE_EMAIL_ID))!;
    expect(email.mailboxIds[MB.inbox]).toBe(true);
    expect(email.from?.[0].email).toBe('billing@spreehost.example');
    const [att] = email.attachments!;
    // What the E-Invoices plugin reads: an .xml attachment (its detect.js kindOf).
    expect(att.name).toBe(INVOICE_FILE);
    expect(att.name).toMatch(/\.xml$/);
    const xml = await (await client.fetchBlob(att.blobId)).text();
    expect(xml).toBe(createSpreehostInvoiceXml());
    expect(new TextEncoder().encode(xml).length).toBe(att.size);

    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const one = (name: string) => doc.getElementsByTagNameNS('*', name)[0]?.textContent ?? '';
    expect(one('CustomizationID')).toContain('xrechnung_3.0');
    expect(one('BuyerReference')).not.toBe('');
    const lines = [...doc.getElementsByTagNameNS('*', 'InvoiceLine')]
      .map((l) => Number(l.getElementsByTagNameNS('*', 'LineExtensionAmount')[0].textContent));
    const net = lines.reduce((a, b) => a + b, 0);
    expect(net.toFixed(2)).toBe(one('TaxExclusiveAmount'));
    expect((net * 1.19).toFixed(2)).toBe(INVOICE_TOTAL);
    expect(one('PayableAmount')).toBe(INVOICE_TOTAL);
    // Dates follow the clock: issued yesterday, due in the future.
    const today = new Date().toLocaleDateString('sv-SE');
    expect(one('IssueDate') < today).toBe(true);
    expect(one('DueDate') > today).toBe(true);
  });

  it('Tagus Air\'s booking mail carries a flight the booking card trusts and shows', async () => {
    const client = new DemoJMAPClient('work');
    const email = (await client.getEmail(FLIGHT_EMAIL_ID))!;
    expect(email.mailboxIds[MB.inbox]).toBe(true);
    expect(email.from?.[0].email).toBe(FLIGHT_SENDER.email);
    expect(email.headers?.['Authentication-Results']).toContain('dkim=pass header.d=tagusair.example');
    const html = structuredHtmlPart(email)!.value;
    expect(html).toContain(`<script type="application/ld+json">${JSON.stringify(createFlightReservation())}</script>`);
    // What the viewer's useStructuredMail does: trust, read, resolve the airport zones.
    expect(getStructuredMailTrust(email)).toEqual({ trusted: true });
    const { cards } = readStructuredMailDetailed(html, { mailDate: new Date(email.sentAt ?? email.receivedAt) });
    const [card] = resolveCards(cards, await loadAirportZones());
    expect(card?.kind).toBe('flight');
    if (card?.kind !== 'flight') return;
    expect(card.reference).toBe(FLIGHT_REFERENCE);
    expect(card.links.checkin?.url).toContain('tagusair.example');
    const [leg] = card.legs;
    expect([leg.carrierCode, leg.number, leg.departure.place.code, leg.arrival?.place.code]).toEqual(['TQ', '482', 'LIS', 'BER']);
    expect(leg.departure.at).toMatchObject({ date: demoISODate(FLIGHT_DAY).slice(0, 10), time: '17:10:00', zone: 'Europe/Lisbon' });
    expect(leg.arrival?.at).toMatchObject({ time: '21:35:00', zone: 'Europe/Berlin' });
  });
});
