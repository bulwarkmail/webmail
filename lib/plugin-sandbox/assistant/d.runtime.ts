// Area d of the assistant's host APIs, inside the plugin sandbox (see README.md).

import type { CallApi, RuntimeAdditions } from './runtime';
import type { AttachmentImageOptions, AttachmentImageView, AttachmentTextView } from './b.types';
import type {
  FileAttachResult, FileAttachTarget, FileCreateInput, FileCreateResult, FileFindQuery, FileInfo,
} from './d.types';
import { NETWORK_API_TIMEOUT_MS } from '../api-timeouts';

/** The methods this area adds to the plugin's api, by namespace. */
export function runtime(callApi: CallApi): RuntimeAdditions {
  return {
    files: {
      /**
       * The user's files and folders that match, newest first: their own
       * drive and drives others shared with them, without the trash
       * (files:read). See FileFindQuery.
       */
      find: (query?: FileFindQuery) =>
        callApi('files.find', [query], NETWORK_API_TIMEOUT_MS) as Promise<FileInfo[]>,
      /** What a folder holds; without one, the top of the user's drive and what others shared (files:read). */
      list: (folderId?: string | null) =>
        callApi('files.list', [folderId], NETWORK_API_TIMEOUT_MS) as Promise<FileInfo[]>,
      /** The text of a file, as email.getAttachmentText reads attachments (files:read, 30 a minute). */
      getText: (fileId: string, options?: { maxChars?: number }) =>
        callApi('files.getText', [fileId, options], NETWORK_API_TIMEOUT_MS) as Promise<AttachmentTextView>,
      /** A picture file, shrunk as email.getAttachmentImage does (files:read, 30 a minute). */
      getImage: (fileId: string, options?: Omit<AttachmentImageOptions, 'accountId'>) =>
        callApi('files.getImage', [fileId, options], NETWORK_API_TIMEOUT_MS) as Promise<AttachmentImageView>,
      /**
       * Attach files to the open draft ({ composerId }, also compose:write)
       * or to a new one ({ newDraft: { to, subject, body } }, also
       * compose:open). At most 20 files (files:read).
       */
      attach: (fileIds: string[], target: FileAttachTarget) =>
        callApi('files.attach', [fileIds, target], NETWORK_API_TIMEOUT_MS) as Promise<FileAttachResult>,
      /**
       * Save attachments of a message into a folder of the user's own drive
       * (null: the top). files:write and email:read; 20 changes a minute.
       */
      saveAttachments: (emailId: string, blobIds: string[], folderId?: string | null, options?: { accountId?: string }) =>
        callApi('files.saveAttachments', [emailId, blobIds, folderId, options], NETWORK_API_TIMEOUT_MS) as Promise<{ saved: FileInfo[]; stopped: string[] }>,
      /**
       * A new text or Markdown file in the user's own drive, or new content
       * for one (replace: the old version goes into the Files trash).
       * files:write; 20 changes a minute.
       */
      create: (input: FileCreateInput) =>
        callApi('files.create', [input], NETWORK_API_TIMEOUT_MS) as Promise<FileCreateResult>,
      /** A new folder in the user's own drive (files:write). */
      createFolder: (input: { parentId?: string | null; name: string }) =>
        callApi('files.createFolder', [input], NETWORK_API_TIMEOUT_MS) as Promise<FileInfo>,
      /** Move a file or folder within the user's own drive (files:write). */
      move: (fileId: string, folderId: string | null) =>
        callApi('files.move', [fileId, folderId], NETWORK_API_TIMEOUT_MS) as Promise<{ file: FileInfo; previousFolderId: string | null }>,
      /** Rename a file or folder of the user's own drive (files:write). */
      rename: (fileId: string, name: string) =>
        callApi('files.rename', [fileId, name], NETWORK_API_TIMEOUT_MS) as Promise<{ file: FileInfo; previousName: string }>,
    },
  };
}
