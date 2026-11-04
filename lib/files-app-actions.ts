/**
 * What the app itself does with a file kept in Files (pim-p2-7): a saved message goes into a
 * mail folder, a .csv or .vcf into contacts, an .ics into the calendar, through the same
 * import dialogs a dropped file reaches.
 */

export type FileAppAction = 'import-mail' | 'import-contacts' | 'add-calendar';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function fileAppAction(name: string, type?: string | null): FileAppAction | null {
  const extension = extensionOf(name);
  const mime = (type ?? '').split(';')[0].trim().toLowerCase();
  if (extension === '.eml' || mime === 'message/rfc822') return 'import-mail';
  if (extension === '.ics' || extension === '.ical' || mime === 'text/calendar') return 'add-calendar';
  if (extension === '.vcf' || extension === '.vcard' || mime === 'text/vcard' || mime === 'text/x-vcard') return 'import-contacts';
  if (extension === '.csv' || mime === 'text/csv') return 'import-contacts';
  return null;
}
