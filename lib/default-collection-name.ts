/**
 * Stalwart names the calendar and address book it creates for a new account
 * "Stalwart Calendar (<address>)" and "Stalwart Address Book (<address>)"
 * (registry defaults, 0.16 and 1.0). Settings show those as plain "Calendar"
 * and "Contacts" in the user's language, the way the sidebar shows "Sent"
 * instead of the server's folder name. A name the user chose stays as it is.
 */

const SERVER_DEFAULT_NAMES = {
  calendar: /^Stalwart Calendar(?: \([^()]*\))?$/,
  addressBook: /^Stalwart Address Book(?: \([^()]*\))?$/,
} as const;

export type DefaultCollectionKind = keyof typeof SERVER_DEFAULT_NAMES;

export function isServerDefaultCollectionName(name: string | undefined, kind: DefaultCollectionKind): boolean {
  return !!name && SERVER_DEFAULT_NAMES[kind].test(name.trim());
}

/** The name to show: `plainName` for the server's own default name, else the collection's name. */
export function collectionDisplayName(name: string, kind: DefaultCollectionKind, plainName: string): string {
  return isServerDefaultCollectionName(name, kind) ? plainName : name;
}
