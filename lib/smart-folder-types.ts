/** Version 1 deliberately queries only the active login's own mail account. */
export type SmartFolderCondition =
  | { field: 'hasAttachment'; value: boolean }
  | { field: 'from' | 'subject'; value: string }
  | { field: 'after' | 'before'; value: string };

export interface SmartFolder {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  scope: 'active-account';
  match: 'all' | 'any' | 'not';
  conditions: SmartFolderCondition[];
}

export const SMART_FOLDERS_VERSION = 1 as const;
export const SMART_FOLDER_PREFIX = '__smart_folder__:';
export const smartFolderMailboxId = (id: string) => SMART_FOLDER_PREFIX + id;
export const isSmartFolderId = (id: string | null | undefined): id is string =>
  typeof id === 'string' && id.startsWith(SMART_FOLDER_PREFIX);
