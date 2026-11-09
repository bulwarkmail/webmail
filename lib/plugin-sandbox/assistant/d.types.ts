// Area d of the assistant's host APIs: its permissions and its flags in
// api.host.features (see README.md). Pure: no imports from the app.
//
// api.files: find, read and attach the user's files, save attachments to
// Files, create text and Markdown files and folders, move and rename. Writes
// go only into the user's own drive, never into a folder shared with
// others. There is no call that deletes, shares, makes a public link or
// moves a file to another account.

/** Permissions this area adds to ALL_PERMISSIONS (it uses files:read and files:write). */
export const PERMISSIONS = [] as const;

/** Flags this area adds to api.host.features (missing on older webmails: read them as `=== true`). */
export interface AreaHostFeaturesD {
  /** api.files: the server has Files and the administrator left it on. */
  files?: boolean;
}

/** A file or folder as api.files gives it. */
export interface FileInfo {
  /** Its id for the other api.files calls. A file in a drive someone shared has an id of the form "account:node". */
  id: string;
  name: string;
  /** The folder it is in, from the top of its drive: "/" or "/Documents/2026". */
  path: string;
  /** The folder it is in; null at the top of the drive. */
  parentId: string | null;
  kind: 'file' | 'folder';
  /** The media type of a file; '' for a folder. */
  mimeType: string;
  /** Bytes; 0 for a folder. */
  size: number;
  /** When its content last changed (ISO 8601), '' when the server doesn't say. */
  modified: string;
  /** In a drive another person shared with the user: read and attach only. */
  shared?: boolean;
  /** Whose drive a shared file is in. */
  owner?: string;
}

/** What api.files.find looks for. Every field is optional; all given ones must match. */
export interface FileFindQuery {
  /** Words of the name; each must appear (any case). */
  text?: string;
  /** Only below this folder (any depth). */
  folderId?: string;
  /** document: PDF, Office and text files; also image, pdf, spreadsheet, presentation, text, folder. */
  kind?: 'document' | 'image' | 'pdf' | 'spreadsheet' | 'presentation' | 'text' | 'folder';
  /** Changed on or after this date or time (ISO 8601). */
  modifiedAfter?: string;
  /** Changed before this date or time (ISO 8601). */
  modifiedBefore?: string;
  /** Most results, 1 to 50 (default 20). Newest first. */
  limit?: number;
}

/** What api.files.create writes. */
export interface FileCreateInput {
  /** The folder; null or left out: the top of the user's drive. Ignored with `replace`. */
  folderId?: string | null;
  /** The file name; with `replace` the file keeps its own. */
  name?: string;
  /** The text, at most 512 KB. */
  content: string;
  type: 'text/markdown' | 'text/plain';
  /**
   * Replace this file's content. Only text and Markdown files of the user's
   * own drive. The old version goes into the Files trash first, from where
   * Restore brings it back.
   */
  replace?: string;
}

export interface FileCreateResult {
  /** The file as it is now (a name that was taken comes back as "name (2).md"). */
  file: FileInfo;
  /** With `replace`: where the old version is, by name, in the Files trash. */
  kept?: { trashFolder: string; name: string };
}

/** Where api.files.attach puts the files. */
export type FileAttachTarget =
  | { composerId: string }
  | { newDraft: { to?: string[]; subject?: string; body?: string } };

export interface FileAttachResult {
  /** Names of the files attached. */
  attached: string[];
  /** Names the composer turned down (too big, or a plugin stopped them). */
  refused: string[];
}
