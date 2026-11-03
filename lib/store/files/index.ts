import type { StoreArea } from '../area';
import { fileBlob, keptStatus, noteOpened, pinFile, readFile, unpinFile, type NodeRef } from './keep';
import { FILE_METHODS } from './methods';
import { FILE_MIGRATIONS } from './schema';
import { filesSyncer } from './sync';

export { fileBlob, FILE_CACHE_CAP_BYTES } from './keep';

export const filesArea: StoreArea = {
  name: 'files',
  migrations: FILE_MIGRATIONS,
  methods: FILE_METHODS,
  syncers: [filesSyncer],
  calls: {
    /** Keep this file's content on the device until it's unpinned. */
    'files.pin': (ctx, params: NodeRef) => pinFile(ctx, params),
    'files.unpin': (ctx, params: NodeRef) => unpinFile(ctx, params),
    /** The page opened this file: keep its content for a while. */
    'files.noteOpened': (ctx, params: NodeRef) => noteOpened(ctx, params),
    /** A kept file's content and name, or null. */
    'files.read': (ctx, params: NodeRef) => readFile(ctx, params),
    /** A kept content by blob id, or null. */
    'files.blob': (ctx, params: { jmap: string; blobId: string }) => fileBlob(ctx, params.jmap, params.blobId),
    /** Pinned and recently opened files, for a settings page. */
    'files.kept': (ctx) => keptStatus(ctx),
  },
};
