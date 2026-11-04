/**
 * Which choices the file drop overlay offers, with nothing of React or the DOM in it.
 *
 * Two main choices everywhere: attach to a new message, upload to Files. An open composer
 * comes first, and a file the app knows (.ics, .vcf, .eml) adds its own. Never more than
 * four, so the zones stay big enough to hit with a drag.
 *
 * During a drag the browser shows only how many files there are and their MIME types,
 * never names or sizes (Chromium's protected drag data). So kinds come from the type
 * then, from the name once dropped, and a size limit is shown on the zone rather than
 * checked against files nobody can measure yet.
 */

import { kindForFile, type HandoffKind } from '@/lib/launch-handoff';

export type FileDropZoneId = 'attach-here' | 'new-message' | 'upload' | 'calendar' | 'contacts' | 'open-eml' | 'import-eml';

export type DroppedKind = Exclude<HandoffKind, 'compose'> | 'other';

export interface DropFiles {
  /** Unknown during a drag in some browsers (Safari gives no items). */
  count: number | null;
  /** One per file, when known. */
  kinds: DroppedKind[] | null;
  /** Known only once the files are in hand. */
  bytes: number | null;
}

export interface DropPlace {
  /** A composer is on screen and takes files. */
  composer: boolean;
  /** A pop-out window: only its own composer, nothing that needs the main window. */
  popout: boolean;
  /** Files is on for this account and its server has it. */
  files: boolean;
  /** On the Files screen, the folder in view, when files can go there. */
  filesFolder: string | null;
  calendar: boolean;
  contacts: boolean;
  /** On the mail screen, a real folder in view that takes new messages. */
  importFolder: string | null;
  /** No connection to the mail server. */
  offline: boolean;
  /** Offline mode keeps a draft and its files until the connection is back. */
  keepsOffline: boolean;
  /** 0: the server says nothing. */
  maxUploadBytes: number;
  maxMessageBytes: number;
}

export type FileDropNote =
  | { key: 'note_limit_message'; size: number }
  | { key: 'note_limit_file'; size: number }
  | { key: 'note_kept_offline' }
  | { key: 'note_needs_connection' };

export interface FileDropZone {
  id: FileDropZoneId;
  /** Names the folder for `upload` on the Files screen and for `import-eml`. */
  folder?: string;
  note?: FileDropNote;
  /** Shown, with the note saying why, and takes no drop. */
  disabled?: boolean;
}

export const MAX_ZONES = 4;

/** What a dragged item's MIME type says. Empty or anything else: no special choice. */
function dropped(kind: HandoffKind | null): DroppedKind {
  return kind && kind !== 'compose' ? kind : 'other';
}

export function kindForType(type: string): DroppedKind {
  return dropped(kindForFile({ name: '', type }));
}

export function kindForName(file: { name: string; type?: string }): DroppedKind {
  return dropped(kindForFile(file));
}

/** The one kind every file shares, or null for a mix or for none known. */
export function sharedKind(files: DropFiles): DroppedKind | null {
  if (!files.kinds || files.kinds.length === 0) return null;
  const [first] = files.kinds;
  return files.kinds.every((kind) => kind === first) ? first : null;
}

function mailNote(place: DropPlace): Pick<FileDropZone, 'note' | 'disabled'> {
  if (place.offline && !place.keepsOffline) return { note: { key: 'note_needs_connection' }, disabled: true };
  if (place.offline) return { note: { key: 'note_kept_offline' } };
  return place.maxMessageBytes > 0 ? { note: { key: 'note_limit_message', size: place.maxMessageBytes } } : {};
}

function serverOnly(place: DropPlace, zone: FileDropZone): FileDropZone {
  return place.offline ? { ...zone, note: { key: 'note_needs_connection' }, disabled: true } : zone;
}

/** The zones for these files here, in the order they're shown. */
export function fileDropZones(files: DropFiles, place: DropPlace): FileDropZone[] {
  const kind = sharedKind(files);
  const one = files.count === 1;
  const main: FileDropZone[] = [];
  if (place.composer) main.push({ id: 'attach-here', ...mailNote(place) });
  if (!place.popout) main.push({ id: 'new-message', ...mailNote(place) });
  if (!place.popout && place.files) {
    const note: FileDropNote | undefined = place.maxUploadBytes > 0 ? { key: 'note_limit_file', size: place.maxUploadBytes } : undefined;
    main.push(serverOnly(place, { id: 'upload', ...(place.filesFolder ? { folder: place.filesFolder } : {}), ...(note ? { note } : {}) }));
  }

  // What this kind of file is for, best first. Not in a pop-out: each opens on its own page.
  const special: FileDropZone[] = [];
  if (!place.popout) {
    if (kind === 'eml' && one) special.push({ id: 'open-eml' });
    if (kind === 'eml' && place.importFolder) special.push(serverOnly(place, { id: 'import-eml', folder: place.importFolder }));
    if (kind === 'calendar' && one && place.calendar) special.push({ id: 'calendar' });
    if (kind === 'contacts' && one && place.contacts) special.push({ id: 'contacts' });
  }

  const room = Math.max(0, MAX_ZONES - main.length);
  const kept = special.slice(0, room);
  const attachHere = main.filter((zone) => zone.id === 'attach-here');
  const rest = main.filter((zone) => zone.id !== 'attach-here');
  return [...attachHere, ...kept, ...rest];
}

/** What the files may still do, once they're in hand: those too big for the zone stay out. */
export function filesWithinLimits(
  zone: FileDropZoneId,
  files: readonly File[],
  place: Pick<DropPlace, 'maxUploadBytes' | 'maxMessageBytes'>,
): { fitting: File[]; tooLarge: File[]; overMessage: boolean } {
  const perFile = place.maxUploadBytes;
  const fitting = perFile > 0 ? files.filter((file) => file.size <= perFile) : [...files];
  const tooLarge = files.filter((file) => !fitting.includes(file));
  const mail = zone === 'attach-here' || zone === 'new-message';
  const total = fitting.reduce((sum, file) => sum + file.size, 0);
  const overMessage = mail && place.maxMessageBytes > 0 && total > place.maxMessageBytes;
  return { fitting: overMessage ? [] : fitting, tooLarge, overMessage };
}

/** The zone a keyboard user lands on: the asked-for one if it's there and usable, else the first usable. */
export function defaultZone(zones: readonly FileDropZone[], preferred?: FileDropZoneId): FileDropZone | undefined {
  const usable = zones.filter((zone) => !zone.disabled);
  return usable.find((zone) => zone.id === preferred) ?? usable[0];
}
