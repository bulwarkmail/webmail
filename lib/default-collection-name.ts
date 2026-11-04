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

/**
 * The name to show for a collection anywhere in the app: the plain name for the
 * user's own default one, and for a colleague's shared default the plain name with
 * whose it is ("Calendar (bob@example.org)"), so two of them stay apart.
 */
export function collectionLabel(
  collection: { name: string; isShared?: boolean },
  kind: DefaultCollectionKind,
  plainName: string,
): string {
  const { name } = collection;
  if (!isServerDefaultCollectionName(name, kind)) return name;
  if (!collection.isShared) return plainName;
  const owner = /\(([^()]*)\)\s*$/.exec(name.trim())?.[1];
  return owner ? `${plainName} (${owner})` : plainName;
}
