import type { SourceFolder, TargetMailbox } from './types';

/**
 * Where each source folder goes on the target. Special folders go into the
 * target's folder with that role: by SPECIAL-USE first, then by the names
 * Open-Xchange, Kopano, Dovecot and Outlook give them in English and German.
 * Every other folder is recreated with the same hierarchy, reusing a folder
 * that already has the same name under the same parent.
 */

const SPECIAL_USE_ROLES: Record<string, string> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
};

const ROLE_NAMES: Record<string, string[]> = {
  sent: ['sent', 'sent items', 'sent messages', 'sent mail', 'gesendet', 'gesendete objekte', 'gesendete elemente'],
  drafts: ['drafts', 'entwürfe', 'entwurf'],
  trash: ['trash', 'deleted items', 'deleted messages', 'papierkorb', 'gelöschte objekte', 'gelöschte elemente'],
  junk: ['junk', 'spam', 'junk e-mail', 'junk-e-mail', 'junk email', 'junk-mail'],
  archive: ['archive', 'archives', 'archiv'],
};

const NAME_TO_ROLE = new Map<string, string>(
  Object.entries(ROLE_NAMES).flatMap(([role, names]) => names.map((name) => [name, role] as [string, string])),
);

/** The path split into its names, on the folder's own delimiter. */
export function folderSegments(folder: Pick<SourceFolder, 'path' | 'delimiter'>): string[] {
  if (!folder.delimiter) return [folder.path];
  return folder.path.split(folder.delimiter).filter((part) => part !== '');
}

function isInbox(segment: string): boolean {
  return segment.toUpperCase() === 'INBOX';
}

/**
 * The JMAP role a folder maps to, or null. Names count only at the top level
 * and directly under INBOX, where Open-Xchange and Dovecot keep them
 * (INBOX/Sent Items, INBOX.Trash).
 */
export function roleForFolder(folder: SourceFolder): string | null {
  const segments = folderSegments(folder);
  if (segments.length === 1 && isInbox(segments[0])) return 'inbox';
  const special = folder.specialUse ? SPECIAL_USE_ROLES[folder.specialUse.toLowerCase()] : undefined;
  if (special) return special;
  const nested = segments.length === 2 && isInbox(segments[0]);
  if (segments.length !== 1 && !nested) return null;
  return NAME_TO_ROLE.get(segments[segments.length - 1].trim().toLowerCase()) ?? null;
}

/**
 * The role of every folder, one folder per role: SPECIAL-USE wins over a
 * name, and of two folders with the same kind of claim the first in the
 * list. A folder that lost is copied as an ordinary folder.
 */
export function assignRoles(folders: SourceFolder[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const bySpecialUse = folders.filter((f) => f.specialUse && SPECIAL_USE_ROLES[f.specialUse.toLowerCase()]);
  const rest = folders.filter((f) => !bySpecialUse.includes(f));
  for (const folder of [...bySpecialUse, ...rest]) {
    const role = roleForFolder(folder);
    if (!role || taken.has(role)) continue;
    taken.add(role);
    out.set(folder.path, role);
  }
  return out;
}

export interface MailboxCreator {
  createMailbox(name: string, parentId: string | null): Promise<string>;
}

/**
 * Resolves source folders to target mailbox ids, creating what is missing.
 * Keeps the target list it was given up to date with what it creates, so
 * folders sharing a parent create it once.
 */
export class FolderPlanner {
  private readonly byPath = new Map<string, string>();
  private readonly roles: Map<string, string>;
  private created = 0;

  constructor(
    private readonly folders: SourceFolder[],
    private readonly mailboxes: TargetMailbox[],
    private readonly target: MailboxCreator,
  ) {
    this.roles = assignRoles(folders);
  }

  /** Folders this planner created on the target. */
  get createdCount(): number {
    return this.created;
  }

  roleOf(path: string): string | null {
    return this.roles.get(path) ?? null;
  }

  /** The target mailbox id for a source folder path, created when missing. */
  async resolve(folder: Pick<SourceFolder, 'path' | 'delimiter'>): Promise<string> {
    const known = this.byPath.get(folder.path);
    if (known) return known;
    const role = this.roles.get(folder.path);
    if (role) {
      const withRole = this.mailboxes.find((m) => m.role === role);
      if (withRole) {
        this.byPath.set(folder.path, withRole.id);
        return withRole.id;
      }
    }
    const segments = folderSegments(folder);
    let parentId: string | null = null;
    if (segments.length > 1) {
      const parentPath = segments.slice(0, -1).join(folder.delimiter);
      // INBOX/… on the source: Stalwart keeps folders beside the inbox, but
      // a folder the user put under INBOX goes under the target's inbox too.
      parentId = await this.resolve({ path: this.sourcePath(parentPath), delimiter: folder.delimiter });
    }
    const name = segments[segments.length - 1];
    const existing = this.mailboxes.find((m) => m.parentId === parentId && m.name === name);
    let id: string;
    if (existing) {
      id = existing.id;
    } else {
      id = await this.target.createMailbox(name, parentId);
      this.mailboxes.push({ id, name, parentId, role: null });
      this.created++;
    }
    this.byPath.set(folder.path, id);
    return id;
  }

  /** The source's own spelling of a parent path (INBOX may come in any case). */
  private sourcePath(path: string): string {
    const match = this.folders.find((f) => f.path.toLowerCase() === path.toLowerCase());
    return match ? match.path : path;
  }
}
