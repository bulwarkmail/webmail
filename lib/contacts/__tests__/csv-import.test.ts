import { describe, expect, it } from 'vitest';
import {
  csvToContacts, decodeCsvBytes, detectDelimiter, matchColumns, parseCsv, parseCsvDate, readCsv,
  type CsvColumn, type CsvTable,
} from '../csv-import';

// Exports shaped like the real ones (headers in the order Outlook and Google
// write them), filled with made-up people.

const OUTLOOK_EN_HEADERS = ['Title', 'First Name', 'Middle Name', 'Last Name', 'Suffix', 'Company', 'Department', 'Job Title',
  'Business Street', 'Business Street 2', 'Business Street 3', 'Business City', 'Business State', 'Business Postal Code',
  'Business Country/Region', 'Home Street', 'Home Street 2', 'Home Street 3', 'Home City', 'Home State', 'Home Postal Code',
  'Home Country/Region', 'Other Street', 'Other Street 2', 'Other Street 3', 'Other City', 'Other State', 'Other Postal Code',
  'Other Country/Region', "Assistant's Phone", 'Business Fax', 'Business Phone', 'Business Phone 2', 'Callback', 'Car Phone',
  'Company Main Phone', 'Home Fax', 'Home Phone', 'Home Phone 2', 'ISDN', 'Mobile Phone', 'Other Fax', 'Other Phone', 'Pager',
  'Primary Phone', 'Radio Phone', 'TTY/TDD Phone', 'Telex', 'Account', 'Anniversary', "Assistant's Name", 'Billing Information',
  'Birthday', 'Business Address PO Box', 'Categories', 'Children', 'Directory Server', 'E-mail Address', 'E-mail Type',
  'E-mail Display Name', 'E-mail 2 Address', 'E-mail 2 Type', 'E-mail 2 Display Name', 'E-mail 3 Address', 'E-mail 3 Type',
  'E-mail 3 Display Name', 'Gender', 'Government ID Number', 'Hobby', 'Home Address PO Box', 'Initials', 'Internet Free Busy',
  'Keywords', 'Language', 'Location', "Manager's Name", 'Mileage', 'Notes', 'Office Location', 'Organizational ID Number',
  'Other Address PO Box', 'Priority', 'Private', 'Profession', 'Referred By', 'Sensitivity', 'Spouse', 'User 1', 'User 2',
  'User 3', 'User 4', 'Web Page'];

const OUTLOOK_DE_HEADERS = ['Anrede', 'Vorname', 'Weitere Vornamen', 'Nachname', 'Suffix', 'Firma', 'Abteilung', 'Position',
  'Straße geschäftlich', 'Straße geschäftlich 2', 'Straße geschäftlich 3', 'Ort geschäftlich', 'Region geschäftlich',
  'Postleitzahl geschäftlich', 'Land/Region geschäftlich', 'Straße privat', 'Straße privat 2', 'Straße privat 3', 'Ort privat',
  'Bundesland/Kanton privat', 'Postleitzahl privat', 'Land/Region privat', 'Weitere Straße', 'Weitere Straße 2',
  'Weitere Straße 3', 'Weiterer Ort', 'Weiteres/r Bundesland/Kanton', 'Weitere Postleitzahl', 'Weiteres/r Land/Region',
  'Telefon Assistent', 'Fax geschäftlich', 'Telefon geschäftlich', 'Telefon geschäftlich 2', 'Rückmeldung', 'Autotelefon',
  'Telefon Firma', 'Fax privat', 'Telefon privat', 'Telefon privat 2', 'ISDN', 'Mobiltelefon', 'Weiteres Fax',
  'Weiteres Telefon', 'Pager', 'Haupttelefon', 'Mobiltelefon 2', 'Telefon für Hörbehinderte', 'Telex',
  'Abrechnungsinformation', 'Benutzer 1', 'Benutzer 2', 'Benutzer 3', 'Benutzer 4', 'Beruf', 'Büro', 'E-Mail-Adresse',
  'E-Mail-Typ', 'E-Mail: Angezeigter Name', 'E-Mail 2: Adresse', 'E-Mail 2: Typ', 'E-Mail 2: Angezeigter Name',
  'E-Mail 3: Adresse', 'E-Mail 3: Typ', 'E-Mail 3: Angezeigter Name', 'Empfohlen von', 'Geburtstag', 'Geschlecht', 'Hobby',
  'Initialen', 'Internet-Frei/Gebucht', 'Jahrestag', 'Kategorien', 'Kinder', 'Konto', 'Name Assistent',
  'Name des/der Vorgesetzten', 'Notizen', 'Organisations-Nr.', 'Ort', 'Partner', 'Postfach geschäftlich', 'Postfach privat',
  'Priorität', 'Privat', 'Regierungs-Nr.', 'Reisekilometer', 'Sprache', 'Stichwörter', 'Vertraulichkeit', 'Verzeichnisserver',
  'Webseite', 'Weiteres Postfach'];

const GOOGLE_HEADERS = ['First Name', 'Middle Name', 'Last Name', 'Phonetic First Name', 'Phonetic Middle Name',
  'Phonetic Last Name', 'Name Prefix', 'Name Suffix', 'Nickname', 'File As', 'Organization Name', 'Organization Title',
  'Organization Department', 'Birthday', 'Notes', 'Photo', 'Labels', 'E-mail 1 - Label', 'E-mail 1 - Value',
  'E-mail 2 - Label', 'E-mail 2 - Value', 'Phone 1 - Label', 'Phone 1 - Value', 'Phone 2 - Label', 'Phone 2 - Value',
  'Address 1 - Label', 'Address 1 - Formatted', 'Address 1 - Street', 'Address 1 - City', 'Address 1 - PO Box',
  'Address 1 - Region', 'Address 1 - Postal Code', 'Address 1 - Country', 'Address 1 - Extended Address',
  'Address 2 - Label', 'Address 2 - Formatted', 'Address 2 - Street', 'Address 2 - City', 'Address 2 - PO Box',
  'Address 2 - Region', 'Address 2 - Postal Code', 'Address 2 - Country', 'Address 2 - Extended Address',
  'Website 1 - Label', 'Website 1 - Value'];

const GOOGLE_OLD_HEADERS = ['Name', 'Given Name', 'Additional Name', 'Family Name', 'Yomi Name', 'Given Name Yomi',
  'Additional Name Yomi', 'Family Name Yomi', 'Name Prefix', 'Name Suffix', 'Initials', 'Nickname', 'Short Name',
  'Maiden Name', 'Birthday', 'Gender', 'Location', 'Billing Information', 'Directory Server', 'Mileage', 'Occupation',
  'Hobby', 'Sensitivity', 'Priority', 'Subject', 'Notes', 'Language', 'Photo', 'Group Membership', 'E-mail 1 - Type',
  'E-mail 1 - Value', 'E-mail 2 - Type', 'E-mail 2 - Value', 'Phone 1 - Type', 'Phone 1 - Value', 'Phone 2 - Type',
  'Phone 2 - Value', 'Address 1 - Type', 'Address 1 - Formatted', 'Address 1 - Street', 'Address 1 - City',
  'Address 1 - PO Box', 'Address 1 - Region', 'Address 1 - Postal Code', 'Address 1 - Country',
  'Address 1 - Extended Address', 'Organization 1 - Type', 'Organization 1 - Name', 'Organization 1 - Yomi Name',
  'Organization 1 - Title', 'Organization 1 - Department', 'Organization 1 - Symbol', 'Organization 1 - Location',
  'Organization 1 - Job Description', 'Website 1 - Type', 'Website 1 - Value'];

function quote(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A CSV file as the exporter writes it: every row has every column. */
function csv(headers: string[], rows: Array<Record<string, string>>, opts: { delimiter?: string; quoteAll?: boolean } = {}): string {
  const d = opts.delimiter ?? ',';
  const line = (cells: string[]) => cells.map((c) => (opts.quoteAll ? `"${c.replace(/"/g, '""')}"` : quote(c, d))).join(d);
  for (const row of rows) for (const key of Object.keys(row)) if (!headers.includes(key)) throw new Error(`no column ${key}`);
  return [line(headers), ...rows.map((row) => line(headers.map((h) => row[h] ?? '')))].join('\r\n') + '\r\n';
}

/** Windows-1252, as German Outlook writes the file. */
function cp1252(text: string): Uint8Array {
  const high: Record<string, number> = { '€': 0x80, '„': 0x84, '“': 0x93, '”': 0x94, '–': 0x96 };
  return Uint8Array.from([...text].map((ch) => {
    if (high[ch]) return high[ch];
    const code = ch.charCodeAt(0);
    if (code > 0xff) throw new Error(`not in cp1252: ${ch}`);
    return code;
  }));
}

function importText(text: string) {
  const table = readCsv(text);
  const columns = matchColumns(table);
  return { table, columns, cards: csvToContacts(table, columns) };
}

const target = (columns: CsvColumn[], header: string) => columns.find((c) => c.header === header)?.target;

describe('reading CSV', () => {
  it('keeps quoted delimiters, doubled quotes and line breaks inside a field', () => {
    const rows = parseCsv('a,b,c\r\n"Smith, Jane","say ""hi""","line 1\r\nline 2"\r\n\r\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['Smith, Jane', 'say "hi"', 'line 1\r\nline 2']]);
  });

  it('finds the delimiter from the header line', () => {
    expect(detectDelimiter('"Vorname";"Nachname";"Firma"\r\nA;B;C')).toBe(';');
    expect(detectDelimiter('First Name,Last Name\nA;B,C')).toBe(',');
    expect(detectDelimiter('First Name\tLast Name\n')).toBe('\t');
  });

  it('drops a UTF-8 byte order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('First Name,Last Name\r\nJürgen,Beispiel\r\n')]);
    const table = readCsv(decodeCsvBytes(bytes));
    expect(table.headers[0]).toBe('First Name');
    expect(table.rows).toEqual([['Jürgen', 'Beispiel']]);
  });

  it('reads UTF-16 with a byte order mark', () => {
    const text = 'First Name\r\nÉlodie\r\n';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) bytes[2 + i * 2] = text.charCodeAt(i);
    expect(readCsv(decodeCsvBytes(bytes)).rows).toEqual([['Élodie']]);
  });

  it('falls back to Windows-1252 when the bytes are not UTF-8', () => {
    expect(decodeCsvBytes(cp1252('Straße „Hauptweg“ 5 – 10 €'))).toBe('Straße „Hauptweg“ 5 – 10 €');
    // Valid UTF-8 stays UTF-8.
    expect(decodeCsvBytes(new TextEncoder().encode('Müller'))).toBe('Müller');
  });

  it('reads Outlook, Google and German dates, and none for Outlook\'s empty ones', () => {
    expect(parseCsvDate('4/12/1985')).toEqual({ year: 1985, month: 4, day: 12 });
    expect(parseCsvDate('25/12/1985')).toEqual({ year: 1985, month: 12, day: 25 });
    expect(parseCsvDate('12.04.1985')).toEqual({ year: 1985, month: 4, day: 12 });
    expect(parseCsvDate('1985-04-12')).toEqual({ year: 1985, month: 4, day: 12 });
    expect(parseCsvDate('--04-12')).toEqual({ month: 4, day: 12 });
    expect(parseCsvDate('0/0/00')).toBeUndefined();
    expect(parseCsvDate('0.0.00')).toBeUndefined();
  });
});

describe('Outlook (English)', () => {
  const text = csv(OUTLOOK_EN_HEADERS, [{
    Title: 'Dr.', 'First Name': 'Jane', 'Middle Name': 'Q.', 'Last Name': 'Sample', Company: 'Example Ltd',
    Department: 'Research', 'Job Title': 'Lead chemist', 'Business Street': '1 Lab Road', 'Business Street 2': 'Building 4',
    'Business City': 'Springfield', 'Business State': 'IL', 'Business Postal Code': '62701', 'Business Country/Region': 'United States',
    'Home Street': '22 Elm St', 'Home City': 'Springfield', 'Home Postal Code': '62702',
    'Business Fax': '+1 217 555 0101', 'Business Phone': '+1 217 555 0100', 'Home Phone': '+1 217 555 0199',
    'Mobile Phone': '+1 217 555 0142', Birthday: '4/12/1985', Anniversary: '0/0/00', Categories: 'Clients;VIP',
    'E-mail Address': 'jane.sample@example.com', 'E-mail Type': 'SMTP', 'E-mail Display Name': 'Jane Sample (jane.sample@example.com)',
    'E-mail 2 Address': 'jane@home.example.net', 'E-mail 2 Type': 'SMTP',
    Notes: 'Met at the "Chem, Expo"\r\nSecond line', 'Web Page': 'https://example.com/jane', Private: 'False', Sensitivity: 'Normal',
  }, {
    'First Name': 'Max', 'Last Name': 'Example', 'E-mail Address': 'max@example.org', Birthday: '0/0/00',
  }], { quoteAll: true });

  it('matches the known columns and leaves the rest out', () => {
    const { columns } = importText(text);
    expect(target(columns, 'First Name')).toBe('name.given');
    expect(target(columns, 'Title')).toBe('name.prefix');
    expect(target(columns, 'E-mail 2 Address')).toBe('email');
    expect(target(columns, 'E-mail 2 Type')).toBe('skip');
    expect(target(columns, 'E-mail Display Name')).toBe('skip');
    expect(target(columns, 'Business Country/Region')).toBe('adr.work.country');
    expect(target(columns, "Assistant's Phone")).toBe('phone');
    expect(target(columns, 'Private')).toBe('skip');
    expect(columns.find((c) => c.header === 'Company')?.sample).toBe('Example Ltd');
  });

  it('builds the cards', () => {
    const { cards } = importText(text);
    expect(cards).toHaveLength(2);
    const [jane, max] = cards;
    expect(jane.name?.components).toEqual([
      { kind: 'title', value: 'Dr.' }, { kind: 'given', value: 'Jane' }, { kind: 'given2', value: 'Q.' }, { kind: 'surname', value: 'Sample' },
    ]);
    expect(Object.values(jane.emails ?? {}).map((e) => e.address)).toEqual(['jane.sample@example.com', 'jane@home.example.net']);
    expect(Object.values(jane.phones ?? {})).toEqual(expect.arrayContaining([
      { number: '+1 217 555 0101', contexts: { work: true }, features: { fax: true } },
      { number: '+1 217 555 0100', contexts: { work: true } },
      { number: '+1 217 555 0199', contexts: { private: true } },
      { number: '+1 217 555 0142', features: { mobile: true } },
    ]));
    expect(Object.values(jane.organizations ?? {})).toEqual([{ name: 'Example Ltd', units: [{ name: 'Research' }] }]);
    expect(Object.values(jane.titles ?? {})).toEqual([{ name: 'Lead chemist', kind: 'title', organizationId: 'o0' }]);
    const addresses = Object.values(jane.addresses ?? {});
    expect(addresses).toHaveLength(2);
    expect(addresses.find((a) => a.contexts?.work)?.components).toEqual([
      { kind: 'name', value: '1 Lab Road\nBuilding 4' }, { kind: 'locality', value: 'Springfield' }, { kind: 'region', value: 'IL' },
      { kind: 'postcode', value: '62701' }, { kind: 'country', value: 'United States' },
    ]);
    expect(addresses.find((a) => a.contexts?.private)?.components).toEqual([
      { kind: 'name', value: '22 Elm St' }, { kind: 'locality', value: 'Springfield' }, { kind: 'postcode', value: '62702' },
    ]);
    expect(Object.values(jane.anniversaries ?? {})).toEqual([{ kind: 'birth', date: { year: 1985, month: 4, day: 12 } }]);
    expect(jane.keywords).toEqual({ Clients: true, VIP: true });
    expect(Object.values(jane.notes ?? {})).toEqual([{ note: 'Met at the "Chem, Expo"\r\nSecond line' }]);
    expect(Object.values(jane.onlineServices ?? {})).toEqual([{ uri: 'https://example.com/jane' }]);

    expect(max.name?.components).toEqual([{ kind: 'given', value: 'Max' }, { kind: 'surname', value: 'Example' }]);
    expect(max.anniversaries).toBeUndefined();
    expect(max.addresses).toBeUndefined();
  });
});

describe('Outlook (German)', () => {
  const text = csv(OUTLOOK_DE_HEADERS, [{
    Anrede: 'Frau', Vorname: 'Erika', Nachname: 'Müßig', Firma: 'Beispiel & Söhne GmbH', Position: 'Geschäftsführerin',
    'Straße geschäftlich': 'Hauptstraße 1', 'Ort geschäftlich': 'Köln', 'Postleitzahl geschäftlich': '50667',
    'Land/Region geschäftlich': 'Deutschland', 'Straße privat': 'Am Weiher 7', 'Ort privat': 'Bonn', 'Postleitzahl privat': '53111',
    'Telefon geschäftlich': '+49 221 1234567', Mobiltelefon: '+49 170 1234567', 'Fax privat': '+49 228 7654321',
    'E-Mail-Adresse': 'erika.muessig@example.de', 'E-Mail-Typ': 'SMTP', 'E-Mail: Angezeigter Name': 'Erika Müßig',
    'E-Mail 2: Adresse': 'erika@privat.example.de', Geburtstag: '12.04.1985', Jahrestag: '0.0.00',
    Kategorien: 'Kunden', Notizen: 'Rabatt 10 €; „Stammkundin“', Privat: 'Aus', Ort: 'Köln',
  }], { delimiter: ';', quoteAll: true });
  const bytes = cp1252(text);

  it('reads the semicolons and the Windows-1252 bytes', () => {
    const table = readCsv(decodeCsvBytes(bytes));
    expect(table.headers).toEqual(OUTLOOK_DE_HEADERS);
    expect(table.rows[0][OUTLOOK_DE_HEADERS.indexOf('Nachname')]).toBe('Müßig');
  });

  it('matches the German columns and builds the card', () => {
    const { columns, cards } = importText(decodeCsvBytes(bytes));
    expect(target(columns, 'E-Mail-Adresse')).toBe('email');
    expect(target(columns, 'E-Mail 2: Adresse')).toBe('email');
    expect(target(columns, 'E-Mail 2: Typ')).toBe('skip');
    expect(target(columns, 'Straße geschäftlich')).toBe('adr.work.street');
    expect(target(columns, 'Bundesland/Kanton privat')).toBe('adr.home.region');
    expect(target(columns, 'Ort')).toBe('skip');
    expect(target(columns, 'Privat')).toBe('skip');

    expect(cards).toHaveLength(1);
    const [erika] = cards;
    expect(erika.name?.components).toEqual([
      { kind: 'title', value: 'Frau' }, { kind: 'given', value: 'Erika' }, { kind: 'surname', value: 'Müßig' },
    ]);
    expect(Object.values(erika.emails ?? {}).map((e) => e.address)).toEqual(['erika.muessig@example.de', 'erika@privat.example.de']);
    expect(Object.values(erika.phones ?? {})).toEqual(expect.arrayContaining([
      { number: '+49 221 1234567', contexts: { work: true } },
      { number: '+49 170 1234567', features: { mobile: true } },
      { number: '+49 228 7654321', contexts: { private: true }, features: { fax: true } },
    ]));
    expect(Object.values(erika.addresses ?? {}).find((a) => a.contexts?.work)?.components).toEqual([
      { kind: 'name', value: 'Hauptstraße 1' }, { kind: 'locality', value: 'Köln' }, { kind: 'postcode', value: '50667' },
      { kind: 'country', value: 'Deutschland' },
    ]);
    expect(Object.values(erika.organizations ?? {})).toEqual([{ name: 'Beispiel & Söhne GmbH' }]);
    expect(Object.values(erika.titles ?? {})).toEqual([{ name: 'Geschäftsführerin', kind: 'title', organizationId: 'o0' }]);
    expect(Object.values(erika.anniversaries ?? {})).toEqual([{ kind: 'birth', date: { year: 1985, month: 4, day: 12 } }]);
    expect(Object.values(erika.notes ?? {})).toEqual([{ note: 'Rabatt 10 €; „Stammkundin“' }]);
    expect(erika.keywords).toEqual({ Kunden: true });
  });
});

describe('Google Contacts', () => {
  it('reads the current format: typed values, several in one cell, two addresses', () => {
    const text = csv(GOOGLE_HEADERS, [{
      'First Name': 'Ana', 'Last Name': 'Placeholder', Nickname: 'Ani', 'Organization Name': 'Sample Co',
      'Organization Title': 'Designer', Birthday: '--07-30', Labels: '* myContacts ::: Friends ::: * starred',
      'E-mail 1 - Label': '* Work', 'E-mail 1 - Value': 'ana@sample.example',
      'E-mail 2 - Label': 'Home', 'E-mail 2 - Value': 'ana.p@example.net ::: ani@example.net',
      'Phone 1 - Label': 'Mobile', 'Phone 1 - Value': '+44 7700 900123',
      'Phone 2 - Label': 'Work Fax', 'Phone 2 - Value': '+44 20 7946 0000',
      'Address 1 - Label': 'Home', 'Address 1 - Formatted': '5 Mill Lane\nFlat 2\nLeeds LS1 4AB\nUK',
      'Address 1 - Street': '5 Mill Lane', 'Address 1 - Extended Address': 'Flat 2', 'Address 1 - City': 'Leeds',
      'Address 1 - Postal Code': 'LS1 4AB', 'Address 1 - Country': 'UK',
      'Address 2 - Label': 'Work', 'Address 2 - Street': '10 Dock Street', 'Address 2 - City': 'Leeds',
      'Website 1 - Label': 'Profile', 'Website 1 - Value': 'https://example.net/ana',
    }]);
    const { columns, cards } = importText(text);
    expect(target(columns, 'E-mail 1 - Label')).toBe('type');
    expect(target(columns, 'E-mail 1 - Value')).toBe('email');
    expect(target(columns, 'Address 2 - City')).toBe('adr.any.locality');
    expect(target(columns, 'Address 1 - Formatted')).toBe('skip');
    expect(target(columns, 'Phonetic First Name')).toBe('skip');

    const [ana] = cards;
    expect(ana.name?.components).toEqual([{ kind: 'given', value: 'Ana' }, { kind: 'surname', value: 'Placeholder' }]);
    expect(Object.values(ana.nicknames ?? {})).toEqual([{ name: 'Ani' }]);
    expect(Object.values(ana.emails ?? {})).toEqual([
      { address: 'ana@sample.example', contexts: { work: true }, pref: 1 },
      { address: 'ana.p@example.net', contexts: { private: true } },
      { address: 'ani@example.net', contexts: { private: true } },
    ]);
    expect(Object.values(ana.phones ?? {})).toEqual([
      { number: '+44 7700 900123', features: { mobile: true } },
      { number: '+44 20 7946 0000', contexts: { work: true }, features: { fax: true } },
    ]);
    const addresses = Object.values(ana.addresses ?? {});
    expect(addresses).toEqual([
      {
        components: [{ kind: 'name', value: '5 Mill Lane\nFlat 2' }, { kind: 'locality', value: 'Leeds' }, { kind: 'postcode', value: 'LS1 4AB' }, { kind: 'country', value: 'UK' }],
        isOrdered: true, defaultSeparator: ', ', contexts: { private: true },
      },
      {
        components: [{ kind: 'name', value: '10 Dock Street' }, { kind: 'locality', value: 'Leeds' }],
        isOrdered: true, defaultSeparator: ', ', contexts: { work: true },
      },
    ]);
    expect(Object.values(ana.anniversaries ?? {})).toEqual([{ kind: 'birth', date: { month: 7, day: 30 } }]);
    expect(ana.keywords).toEqual({ Friends: true });
    expect(Object.values(ana.organizations ?? {})).toEqual([{ name: 'Sample Co' }]);
    expect(Object.values(ana.titles ?? {})).toEqual([{ name: 'Designer', kind: 'title', organizationId: 'o0' }]);
  });

  it('reads the older format with Given/Family Name and numbered organisations', () => {
    const text = csv(GOOGLE_OLD_HEADERS, [{
      Name: 'Tom Testperson', 'Given Name': 'Tom', 'Family Name': 'Testperson', Birthday: '1990-01-31',
      'Group Membership': '* My Contacts ::: Club', 'E-mail 1 - Type': '* Other', 'E-mail 1 - Value': 'tom@example.org',
      'Phone 1 - Type': 'Home', 'Phone 1 - Value': '+33 1 23 45 67 89',
      'Organization 1 - Type': '', 'Organization 1 - Name': 'Club Example', 'Organization 1 - Title': 'Treasurer',
      'Organization 1 - Department': 'Finance',
    }, {
      // Only a full name: first word given name, the rest surname, as for a vCard FN.
      Name: 'Lea van Probe', 'E-mail 1 - Value': 'lea@example.org',
    }, {
      // Nothing to import.
      Notes: '', Gender: 'female',
    }]);
    const { columns, cards } = importText(text);
    expect(target(columns, 'Name')).toBe('name.full');
    expect(target(columns, 'Given Name')).toBe('name.given');
    expect(target(columns, 'E-mail 1 - Type')).toBe('type');
    expect(target(columns, 'Organization 1 - Department')).toBe('org.unit');
    expect(target(columns, 'Organization 1 - Type')).toBe('skip');

    expect(cards).toHaveLength(2);
    const [tom, lea] = cards;
    expect(tom.name).toEqual({ components: [{ kind: 'given', value: 'Tom' }, { kind: 'surname', value: 'Testperson' }], isOrdered: true, full: 'Tom Testperson' });
    expect(Object.values(tom.emails ?? {})).toEqual([{ address: 'tom@example.org', pref: 1 }]);
    expect(Object.values(tom.phones ?? {})).toEqual([{ number: '+33 1 23 45 67 89', contexts: { private: true } }]);
    expect(Object.values(tom.organizations ?? {})).toEqual([{ name: 'Club Example', units: [{ name: 'Finance' }] }]);
    expect(Object.values(tom.titles ?? {})).toEqual([{ name: 'Treasurer', kind: 'title', organizationId: 'o0' }]);
    expect(tom.keywords).toEqual({ Club: true });
    expect(lea.name?.components).toEqual([{ kind: 'given', value: 'Lea' }, { kind: 'surname', value: 'van Probe' }]);
  });
});

describe('column choices', () => {
  it('leaves out a column set to "Don\'t import" and uses one the user matched by hand', () => {
    const table: CsvTable = readCsv('Vorname,Spalte X,Mail\r\nAnna,Notiz,anna@example.org\r\n');
    const columns = matchColumns(table);
    expect(columns.map((c) => c.target)).toEqual(['name.given', 'skip', 'skip']);
    const chosen = columns.map((c) => (c.header === 'Mail' ? { ...c, target: 'email.work' as const } : c));
    const [card] = csvToContacts(table, chosen);
    expect(Object.values(card.emails ?? {})).toEqual([{ address: 'anna@example.org', contexts: { work: true } }]);
    expect(card.notes).toBeUndefined();
    const skipped = chosen.map((c) => (c.header === 'Vorname' ? { ...c, target: 'skip' as const } : c));
    expect(csvToContacts(table, skipped)[0].name).toBeUndefined();
  });
});
