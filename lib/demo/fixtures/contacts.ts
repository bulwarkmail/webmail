import type { ContactCard, AddressBook } from '@/lib/jmap/types';
import {
  type Person, portraitUri,
  NORA, NORA_PERSONAL, ALICE, BOB, PRIYA, AHMED, JAMES, MICHAEL, RACHEL, WEI, MARIA, LISA,
  SARAH, OLIVIA, JENNIFER, KENJI, SOFIA, ANNA, ELIAS, CARLOS, MARCUS, EMMA, DAVID, DANIEL,
  TOMAS, LENA, YUSUF,
} from './people';

export const AB = {
  personal: 'demo-addressbook-personal',
  work: 'demo-addressbook-work',
  /** The one address book of the personal login. */
  home: 'demo-addressbook-home',
} as const;

export function createDemoAddressBooks(): AddressBook[] {
  return [
    {
      id: AB.personal,
      name: 'Personal',
      isDefault: true,
      isSubscribed: true,
      sortOrder: 1,
      myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: false },
    },
    {
      id: AB.work,
      name: 'Meridian Labs',
      isDefault: false,
      isSubscribed: true,
      sortOrder: 2,
      myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
    },
  ];
}

type Extra = Partial<Omit<ContactCard, 'id' | 'addressBookIds' | 'kind' | 'name' | 'emails' | 'media'>> & {
  /** Further addresses: [address, context]. */
  moreEmails?: Array<[string, 'work' | 'private']>;
};

function person(id: string, book: string, p: Person, context: 'work' | 'private', extra: Extra = {}): ContactCard {
  const { moreEmails, ...rest } = extra;
  const photo = portraitUri(p);
  const emails: ContactCard['emails'] = { e1: { address: p.email, contexts: { [context]: true }, pref: 1 } };
  moreEmails?.forEach(([address, ctx], i) => { emails[`e${i + 2}`] = { address, contexts: { [ctx]: true } }; });
  return {
    id,
    addressBookIds: { [book]: true },
    kind: 'individual',
    name: { components: [{ kind: 'given', value: p.given }, { kind: 'surname', value: p.surname }] },
    emails,
    ...(photo ? { media: { photo1: { kind: 'photo', uri: photo, mediaType: 'image/jpeg' } } } : {}),
    ...rest,
  };
}

const meridian = (unit: string, title: string) => ({
  organizations: { o1: { name: 'Meridian Labs', units: [{ name: unit }] } },
  titles: { t1: { name: title, kind: 'title' as const } },
});
const phone = (number: string, feature: 'voice' | 'cell' = 'cell', context: 'work' | 'private' = 'work') =>
  ({ p1: { number, features: { [feature]: true }, contexts: { [context]: true } } });

export function createDemoContacts(): ContactCard[] {
  return [
    // ── Meridian Labs ──────────────────────────────────────────
    // Nora's own card: it gives her avatar a photo and her @mention a hover card.
    person('demo-contact-nora', AB.work, NORA, 'work', {
      ...meridian('Engineering', 'Engineering Lead'),
      moreEmails: [['nora@lindqvist.example', 'private']],
      phones: phone('+49 30 555 0199', 'voice'),
      anniversaries: { a1: { kind: 'birth', date: { year: 1990, month: 6, day: 2 } } },
    }),
    person('demo-contact-alice', AB.work, ALICE, 'work', {
      ...meridian('Engineering', 'Engineering Manager'),
      phones: phone('+49 30 555 0101', 'voice'),
      anniversaries: { a1: { kind: 'birth', date: { year: 1988, month: 3, day: 15 } } },
      notes: { n1: { note: 'My manager. Prefers written proposals to meetings.' } },
    }),
    person('demo-contact-bob', AB.work, BOB, 'work', {
      ...meridian('Platform', 'Staff Engineer'),
      moreEmails: [['bob.personal@email.example', 'private']],
      phones: { p1: { number: '+49 30 555 0102', features: { voice: true }, contexts: { work: true } }, p2: { number: '+49 171 555 0103', features: { cell: true }, contexts: { private: true } } },
    }),
    person('demo-contact-priya', AB.work, PRIYA, 'work', { ...meridian('Quality', 'QA Lead'), phones: phone('+49 30 555 0104', 'voice') }),
    person('demo-contact-ahmed', AB.work, AHMED, 'work', { ...meridian('Platform', 'Site Reliability Engineer'), phones: phone('+49 171 555 0105') }),
    person('demo-contact-james', AB.work, JAMES, 'work', { ...meridian('Leadership', 'CTO'), phones: phone('+49 30 555 0100', 'voice') }),
    person('demo-contact-michael', AB.work, MICHAEL, 'work', { ...meridian('Product', 'Product Manager, Beacon'), phones: phone('+49 171 555 0106') }),
    person('demo-contact-rachel', AB.work, RACHEL, 'work', { ...meridian('Marketing', 'Marketing Lead') }),
    person('demo-contact-wei', AB.work, WEI, 'work', { ...meridian('Data', 'Data Scientist') }),
    person('demo-contact-maria', AB.work, MARIA, 'work', { ...meridian('People Ops', 'People Partner'), phones: phone('+49 30 555 0108', 'voice') }),
    person('demo-contact-lisa', AB.work, LISA, 'work', { ...meridian('Engineering', 'Frontend Engineer') }),

    // ── Work, outside the company ──────────────────────────────
    person('demo-contact-sarah', AB.work, SARAH, 'work', {
      organizations: { o1: { name: 'DesignCo Studio' } },
      titles: { t1: { name: 'UX Designer', kind: 'title' } },
      phones: phone('+49 30 555 0204', 'voice'),
      addresses: { a1: { components: [{ kind: 'name', value: 'Torstraße' }, { kind: 'number', value: '112' }, { kind: 'postcode', value: '10119' }, { kind: 'locality', value: 'Berlin' }], contexts: { work: true } } },
      notes: { n1: { note: 'Website redesign. Invoices monthly, net 14.' } },
    }),
    person('demo-contact-olivia', AB.work, OLIVIA, 'work', {
      organizations: { o1: { name: 'Northwind Studio' } },
      titles: { t1: { name: 'Product Designer', kind: 'title' } },
    }),
    person('demo-contact-kenji', AB.work, KENJI, 'work', {
      organizations: { o1: { name: 'Infra Summit' } },
      titles: { t1: { name: 'Programme chair', kind: 'title' } },
      phones: phone('+351 21 555 0170', 'voice'),
    }),
    person('demo-contact-jennifer', AB.work, JENNIFER, 'work', {
      organizations: { o1: { name: 'Talent Partners' } },
      titles: { t1: { name: 'Principal Recruiter', kind: 'title' } },
    }),
    person('demo-contact-tomas', AB.work, TOMAS, 'work', {
      organizations: { o1: { name: 'Lumen Logistics', units: [{ name: 'Operations' }] } },
      titles: { t1: { name: 'Head of Operations', kind: 'title' } },
      phones: phone('+351 21 555 0188', 'voice'),
      addresses: { a1: { components: [{ kind: 'name', value: 'Av. da Liberdade' }, { kind: 'number', value: '110' }, { kind: 'postcode', value: '1250-146' }, { kind: 'locality', value: 'Lisboa' }, { kind: 'country', value: 'Portugal' }], contexts: { work: true } } },
      notes: { n1: { note: 'Design partner. Wants Lumen on the Beacon canary.' } },
    }),
    person('demo-contact-lena', AB.work, LENA, 'work', { organizations: { o1: { name: 'Hoffmann & Partner' } }, titles: { t1: { name: 'Partner', kind: 'title' } } }),
    person('demo-contact-yusuf', AB.work, YUSUF, 'work', { organizations: { o1: { name: 'Demir Retail' } }, titles: { t1: { name: 'Lead Developer', kind: 'title' } } }),

    // ── Personal ───────────────────────────────────────────────
    person('demo-contact-sofia', AB.personal, SOFIA, 'private', {
      phones: phone('+39 051 555 0111', 'voice', 'private'),
      addresses: { a1: { components: [{ kind: 'name', value: 'Via Zamboni' }, { kind: 'number', value: '18' }, { kind: 'postcode', value: '40126' }, { kind: 'locality', value: 'Bologna' }, { kind: 'country', value: 'Italy' }], contexts: { private: true } } },
      anniversaries: { a1: { kind: 'birth', date: { year: 1962, month: 5, day: 9 } } },
      notes: { n1: { note: 'Mom. Writing a memoir, "The Lemon Tree Year".' } },
      relatedTo: { [ANNA.email]: { relation: { child: true } } },
    }),
    person('demo-contact-anna', AB.personal, ANNA, 'private', {
      phones: phone('+48 602 555 0144', 'cell', 'private'),
      addresses: { a1: { components: [{ kind: 'name', value: 'ul. Floriańska' }, { kind: 'number', value: '22' }, { kind: 'postcode', value: '31-021' }, { kind: 'locality', value: 'Kraków' }, { kind: 'country', value: 'Poland' }], contexts: { private: true } } },
      anniversaries: { a1: { kind: 'birth', date: { year: 1992, month: 11, day: 4 } } },
      notes: { n1: { note: 'Sister.' } },
    }),
    person('demo-contact-elias', AB.personal, ELIAS, 'private', {
      phones: phone('+46 70 555 0122', 'cell', 'private'),
      addresses: { a1: { components: [{ kind: 'name', value: 'Linnégatan' }, { kind: 'number', value: '41' }, { kind: 'postcode', value: '413 08' }, { kind: 'locality', value: 'Göteborg' }, { kind: 'country', value: 'Sweden' }], contexts: { private: true } } },
      anniversaries: { a1: { kind: 'birth', date: { year: 1986, month: 8, day: 23 } } },
      notes: { n1: { note: 'Brother.' } },
    }),
    person('demo-contact-carlos', AB.personal, CARLOS, 'private', {
      phones: phone('+49 176 555 0105', 'cell', 'private'),
      anniversaries: { a1: { kind: 'birth', date: { month: 10, day: 15 } } },
      notes: { n1: { note: 'Met at DevConf 2024. Organises the Friday dinners.' } },
    }),
    person('demo-contact-marcus', AB.personal, MARCUS, 'private', { notes: { n1: { note: 'Book club host, every other week.' } } }),
    person('demo-contact-emma', AB.personal, EMMA, 'private', {
      addresses: { a1: { components: [{ kind: 'name', value: 'Schönhauser Allee' }, { kind: 'number', value: '56' }, { kind: 'postcode', value: '10437' }, { kind: 'locality', value: 'Berlin' }], contexts: { private: true } } },
      anniversaries: { a1: { kind: 'birth', date: { month: 7, day: 22 } } },
    }),
    person('demo-contact-david', AB.personal, DAVID, 'private', { phones: phone('+82 10 1234 5678', 'cell', 'private') }),
    person('demo-contact-daniel', AB.personal, DANIEL, 'private', {
      organizations: { o1: { name: 'Cooper Creative' } },
      titles: { t1: { name: 'Illustrator', kind: 'title' } },
      notes: { n1: { note: 'Doing the cover for Mom\'s book.' } },
    }),
    {
      id: 'demo-contact-dentist',
      addressBookIds: { [AB.personal]: true },
      kind: 'org',
      name: { components: [{ kind: 'surname', value: 'Zahnarztpraxis Dr. Weber' }] },
      emails: { e1: { address: 'termine@dr-weber.example', pref: 1 } },
      phones: { p1: { number: '+49 30 555 0142', features: { voice: true } } },
      addresses: { a1: { components: [{ kind: 'name', value: 'Kastanienallee' }, { kind: 'number', value: '21' }, { kind: 'postcode', value: '10435' }, { kind: 'locality', value: 'Berlin' }] } },
    },
    {
      id: 'demo-contact-cafe',
      addressBookIds: { [AB.personal]: true },
      kind: 'org',
      name: { components: [{ kind: 'surname', value: 'Café Kranzler' }] },
      emails: { e1: { address: 'hello@kranzler.example', pref: 1 } },
      phones: { p1: { number: '+49 30 555 0200', features: { voice: true } } },
      addresses: { a1: { components: [{ kind: 'name', value: 'Rosenthaler Straße' }, { kind: 'number', value: '38' }, { kind: 'postcode', value: '10178' }, { kind: 'locality', value: 'Berlin' }] } },
      notes: { n1: { note: 'Coffee downstairs from the office.' } },
    },

    // ── Groups ─────────────────────────────────────────────────
    {
      id: 'demo-group-beacon',
      addressBookIds: { [AB.work]: true },
      kind: 'group',
      name: { components: [{ kind: 'surname', value: 'Beacon team' }] },
      members: { 'demo-contact-alice': true, 'demo-contact-bob': true, 'demo-contact-priya': true, 'demo-contact-ahmed': true, 'demo-contact-lisa': true },
    },
    {
      id: 'demo-group-leadership',
      addressBookIds: { [AB.work]: true },
      kind: 'group',
      name: { components: [{ kind: 'surname', value: 'Leadership' }] },
      members: { 'demo-contact-james': true, 'demo-contact-michael': true, 'demo-contact-alice': true },
    },
    {
      id: 'demo-group-family',
      addressBookIds: { [AB.personal]: true },
      kind: 'group',
      name: { components: [{ kind: 'surname', value: 'Family' }] },
      members: { 'demo-contact-sofia': true, 'demo-contact-anna': true, 'demo-contact-elias': true },
    },
    {
      id: 'demo-group-bookclub',
      addressBookIds: { [AB.personal]: true },
      kind: 'group',
      name: { components: [{ kind: 'surname', value: 'Book club' }] },
      members: { 'demo-contact-marcus': true, 'demo-contact-emma': true, 'demo-contact-david': true },
    },
  ];
}

export function createDemoPersonalAddressBooks(): AddressBook[] {
  return [{
    id: AB.home,
    name: 'Contacts',
    isDefault: true,
    isSubscribed: true,
    sortOrder: 1,
    myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: false },
  }];
}

/**
 * The personal login's contacts: Nora's own card and copies of the work
 * account's Personal book. Avatars only look at the open account's cards,
 * so without these every sender of the personal mail, and Nora herself,
 * fell back to initials there.
 */
export function createDemoPersonalContacts(): ContactCard[] {
  const homeId = (id: string) => id.replace(/^demo-/, 'demo-home-');
  const copies = createDemoContacts()
    .filter((card) => card.addressBookIds[AB.personal])
    .map((card) => ({
      ...card,
      id: homeId(card.id),
      addressBookIds: { [AB.home]: true },
      ...(card.members ? { members: Object.fromEntries(Object.keys(card.members).map((id) => [homeId(id), true])) } : {}),
    }));
  return [
    person('demo-home-contact-nora', AB.home, NORA_PERSONAL, 'private', { moreEmails: [[NORA.email, 'work']] }),
    ...copies,
  ];
}

/** The persona as a contact card, for the hover card on her own @mention. */
export const SELF_CONTACT_EMAIL = NORA.email;
