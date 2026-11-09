/**
 * The cast of the demo. One place for every name, address and portrait so
 * the mail, the address books, the calendar and the shared mailbox all agree.
 *
 * The persona is Nora Lindqvist, engineering lead at Meridian Labs in Berlin.
 * She has three mail sources: her work account (the primary login), a
 * personal account on her own domain (a second login) and the company's
 * shared Support mailbox (delegated to her, no login of its own).
 *
 * Portraits are Unsplash photos (free to use under the Unsplash License),
 * resized to 256px and served from public/demo/portraits/.
 */
import { withBasePath } from '@/lib/browser-navigation';
import type { EmailAddress } from '@/lib/jmap/types';

export interface Person extends EmailAddress {
  name: string;
  email: string;
  /** File under public/demo/portraits/, without extension. */
  portrait?: string;
  given: string;
  surname: string;
}

const p = (given: string, surname: string, email: string, portrait?: string): Person =>
  ({ name: `${given} ${surname}`, email, given, surname, portrait });

export const WORK_DOMAIN = 'meridianlabs.example';
export const PERSONAL_DOMAIN = 'lindqvist.example';

// ── The persona ───────────────────────────────────────────────
export const NORA = p('Nora', 'Lindqvist', `nora@${WORK_DOMAIN}`, 'nora-lindqvist');
export const NORA_ALIAS = p('Nora', 'Lindqvist', `nora.lindqvist@${WORK_DOMAIN}`, 'nora-lindqvist');
export const NORA_PERSONAL = p('Nora', 'Lindqvist', `nora@${PERSONAL_DOMAIN}`, 'nora-lindqvist');
export const SUPPORT: Person = { name: 'Meridian Support', email: `support@${WORK_DOMAIN}`, given: 'Meridian', surname: 'Support' };

// ── Meridian Labs ─────────────────────────────────────────────
export const ALICE = p('Alice', 'Johnson', `alice.johnson@${WORK_DOMAIN}`, 'alice-johnson');
export const BOB = p('Bob', 'Chen', `bob.chen@${WORK_DOMAIN}`, 'bob-chen');
export const PRIYA = p('Priya', 'Sharma', `priya.sharma@${WORK_DOMAIN}`, 'priya-sharma');
export const AHMED = p('Ahmed', 'Hassan', `ahmed.hassan@${WORK_DOMAIN}`, 'ahmed-hassan');
export const JAMES = p('James', 'Miller', `james.miller@${WORK_DOMAIN}`, 'james-miller');
export const MICHAEL = p('Michael', 'Torres', `michael.torres@${WORK_DOMAIN}`, 'michael-torres');
export const RACHEL = p('Rachel', 'Green', `rachel.green@${WORK_DOMAIN}`, 'rachel-green');
export const WEI = p('Wei', 'Zhang', `wei.zhang@${WORK_DOMAIN}`, 'wei-zhang');
export const MARIA = p('Maria', 'Lopez', `maria.lopez@${WORK_DOMAIN}`, 'maria-lopez');
export const LISA = p('Lisa', 'Tanaka', `lisa.tanaka@${WORK_DOMAIN}`, 'lisa-tanaka');

// ── Work, outside the company ─────────────────────────────────
export const SARAH = p('Sarah', 'Kim', 'sarah@designco.example', 'sarah-kim');
export const OLIVIA = p('Olivia', 'Bennett', 'olivia@northwind.example', 'olivia-bennett');
export const JENNIFER = p('Jennifer', 'Hayes', 'jennifer@talent-partners.example', 'jennifer-hayes');
export const KENJI = p('Kenji', 'Watanabe', 'kenji@infrasummit.example', 'kenji-watanabe');
/** Meridian Labs' hosting company; sends the monthly e-invoice (fixtures/invoice.ts). */
export const SPREEHOST: Person = { name: 'Spreehost Billing', email: 'billing@spreehost.example', given: 'Spreehost', surname: 'Billing' };

// ── Family and friends ────────────────────────────────────────
export const SOFIA = p('Sofia', 'Russo', 'sofia.russo@example.com', 'sofia-russo');
export const ANNA = p('Anna', 'Kowalski', 'anna.kowalski@example.com', 'anna-kowalski');
export const ELIAS = p('Elias', 'Lindqvist', `elias@${PERSONAL_DOMAIN}`, 'elias-lindqvist');
export const CARLOS = p('Carlos', 'Rivera', 'carlos.rivera@example.com', 'carlos-rivera');
export const MARCUS = p('Marcus', 'Hughes', 'marcus.hughes@example.com', 'marcus-hughes');
export const EMMA = p('Emma', 'Wilson', 'emma.wilson@example.com', 'emma-wilson');
export const DAVID = p('David', 'Park', 'david.park@example.com', 'david-park');
export const DANIEL = p('Daniel', 'Cooper', 'daniel@coopercreative.example', 'daniel-cooper');

// ── Customers writing to Support ──────────────────────────────
export const TOMAS = p('Tomás', 'Ferreira', 'tomas.ferreira@lumenlogistics.example', 'tomas-ferreira');
export const LENA = p('Lena', 'Hoffmann', 'l.hoffmann@hoffmann-partner.example', 'lena-hoffmann');
export const YUSUF = p('Yusuf', 'Demir', 'yusuf@demir-retail.example', 'yusuf-demir');

/** Everyone with a portrait, for the fixture test that checks the files exist. */
export const PORTRAITS: Person[] = [
  NORA, ALICE, BOB, PRIYA, AHMED, JAMES, MICHAEL, RACHEL, WEI, MARIA, LISA,
  SARAH, OLIVIA, JENNIFER, KENJI, SOFIA, ANNA, ELIAS, CARLOS, MARCUS, EMMA, DAVID, DANIEL,
  TOMAS, LENA, YUSUF,
];

// Through withBasePath: a Lite bundle mounted at /webmail must ask for
// /webmail/demo/portraits/..., or the request leaves the bundle.
export const portraitUri = (person: Person): string | undefined =>
  person.portrait ? withBasePath(`/demo/portraits/${person.portrait}.jpg`) : undefined;

/** Plain address, without the fixture-only fields, for From/To lists. */
export const addr = (person: Person): EmailAddress => ({ name: person.name, email: person.email });
