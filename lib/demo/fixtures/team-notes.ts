/**
 * Team notes in the shared Support mailbox (lib/team-mailboxes): what the
 * team wrote beside its messages, as Email/get hands notes back from the
 * "Team notes" folder. They only show where the admin turned team mailboxes
 * on for the Support group; elsewhere the folder stays hidden and nothing
 * changes.
 *
 * Bob gave Tomás's question to Nora and mentions her in a note, Alice adds
 * what billing said, and Bob keeps the departed employee's login to himself.
 * Yusuf's thread was marked done yesterday.
 */
import type { Email } from '@/lib/jmap/types';
import { NOTE_HEADER_PROPERTIES as H, noteKeyFor, type NoteKind } from '@/lib/team-mailboxes/note-format';
import { NOTE_KEYWORD } from '@/lib/team-mailboxes/hidden-folders';
import { ago, at } from './mail';
import { SMB, SUPPORT_ACCOUNT_ID } from './mailboxes';
import { ALICE, BOB, NORA, SUPPORT, type Person } from './people';
import { PRINCIPAL } from './directory';

export type DemoTeamNote = Record<string, unknown> & { id: string; receivedAt: string };

interface NoteSpec {
  id: string;
  about: string;
  at: string;
  author: Person;
  authorId: string;
  kind: NoteKind;
  mentions?: string[];
  text?: string;
}

const SPECS: NoteSpec[] = [
  {
    id: 'tomas-assigned', about: 'demo-support-tomas', at: ago(0, 48),
    author: BOB, authorId: PRINCIPAL.bob, kind: 'assigned', mentions: [PRINCIPAL.nora],
  },
  {
    id: 'tomas-bob', about: 'demo-support-tomas', at: ago(0, 46),
    author: BOB, authorId: PRINCIPAL.bob, kind: 'note', mentions: [PRINCIPAL.nora],
    text: `Sales agreed to 100 tenants last week, so they don't need a new contract. @${NORA.name} can you confirm the canary stays at five?`,
  },
  {
    id: 'tomas-alice', about: 'demo-support-tomas', at: ago(0, 21),
    author: ALICE, authorId: PRINCIPAL.alice, kind: 'note',
    text: 'Checked with billing: the price only changes above 150 tenants. I added that to their account in the CRM.',
  },
  {
    id: 'lena-assigned', about: 'demo-support-lena-reset', at: at(3, 10, 24),
    author: BOB, authorId: PRINCIPAL.bob, kind: 'assigned', mentions: [PRINCIPAL.bob],
  },
  {
    id: 'lena-bob', about: 'demo-support-lena-reset', at: at(3, 10, 31),
    author: BOB, authorId: PRINCIPAL.bob, kind: 'note',
    text: 'Login disabled. Waiting for Lena to confirm before I mark it done.',
  },
  {
    id: 'yusuf-done', about: 'demo-support-yusuf-2', at: at(1, 9, 20),
    author: NORA, authorId: PRINCIPAL.nora, kind: 'done',
  },
];

/** The notes, keyed to the Support mail they are about. */
export function createDemoTeamNotes(emails: readonly Email[]): DemoTeamNote[] {
  const notes: DemoTeamNote[] = [];
  for (const spec of SPECS) {
    const email = emails.find((e) => e.id === spec.about);
    if (!email) continue;
    const keywords: Record<string, boolean> = { $seen: true, [NOTE_KEYWORD]: true };
    if (spec.kind === 'note') for (const id of spec.mentions ?? []) keywords[`$bulwark-mention-${id}`] = true;
    const note: DemoTeamNote = {
      id: `demo-note-${spec.id}`,
      receivedAt: spec.at,
      mailboxIds: { [SMB.notes]: true },
      keywords,
      from: [{ name: spec.author.name, email: spec.author.email }],
      to: [{ name: null, email: SUPPORT.email }],
      subject: `Note: ${email.subject ?? ''}`,
      messageId: [`demo-note-${spec.id}@notes.bulwark.invalid`],
      [H.for]: `<${noteKeyFor(email, SUPPORT_ACCOUNT_ID)}>`,
      [H.thread]: email.threadId,
      [H.kind]: spec.kind,
      [H.author]: spec.authorId,
      textBody: [{ partId: '1', type: 'text/plain' }],
      bodyValues: { '1': { value: spec.text ?? '' } },
    };
    if (spec.mentions?.length) note[H.mentions] = spec.mentions.join(', ');
    notes.push(note);
  }
  return notes;
}
