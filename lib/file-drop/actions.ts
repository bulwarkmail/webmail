/**
 * What each zone of the file drop overlay does with the files, through the paths the app
 * already has: a composer's own attach (its size checks and plugin hooks included), the
 * launch handoff for a new draft and for .ics, .vcf and .eml, the Files screen's upload.
 */

import { visibleComposer } from '@/lib/desktop/window-files';
import { handOffDraft, handOffFiles } from '@/lib/launch-handoff';
import { filesDropTarget, queueFilesUpload, type FilesUpload } from './files-target';
import type { FileDropZoneId } from './zones';

export interface FileDropEnv {
  /** Goes to a page, saving an open composer first. */
  goTo: (path: '/files') => void | Promise<void>;
  /** Email/import into the folder the zone named. */
  importMessages: (files: File[]) => void | Promise<void>;
}

/** `files` without folders for every zone; `upload` also gets what a dropped folder held. */
export async function runFileDropZone(zone: FileDropZoneId, files: File[], env: FileDropEnv, upload?: FilesUpload): Promise<void> {
  if (zone === 'upload') {
    const what = upload ?? { files, asFolder: false };
    if (what.files.length === 0) return;
    const target = filesDropTarget();
    if (target) {
      target.take(what);
      return;
    }
    queueFilesUpload(what);
    await env.goTo('/files');
    return;
  }
  if (files.length === 0) return;
  switch (zone) {
    case 'attach-here': {
      const composer = visibleComposer();
      // Gone between the drag and the drop: a new message is the next best thing.
      if (composer) composer.take(files);
      else handOffDraft({ files });
      return;
    }
    case 'new-message':
      handOffDraft({ files });
      return;
    case 'calendar':
      handOffFiles(files, 'calendar');
      return;
    case 'contacts':
      handOffFiles(files, 'contacts');
      return;
    case 'open-eml':
      handOffFiles(files.slice(0, 1), 'eml');
      return;
    case 'import-eml':
      await env.importMessages(files);
      return;
  }
}
