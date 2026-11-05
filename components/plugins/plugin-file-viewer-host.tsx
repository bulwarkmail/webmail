'use client';

// The file preview for files plugins open (api.ui.openFile) or print as a PDF
// (api.ui.print with `pdf`): the same preview attachments and Files use, so
// the file has the app's Download and Print and nothing of the plugin's own.
// See lib/plugin-sandbox/host-api-file-viewer.ts.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { saveBlobAs } from '@/lib/download-guard';
import { closePluginFile, currentFileView, registerFileViewerHost, subscribeFileView } from '@/lib/plugin-sandbox/file-viewer';

// Loaded with the first file a plugin opens, not with the page.
const FilePreviewModal = dynamic(() => import('@/components/files/file-preview-modal').then((m) => m.FilePreviewModal), { ssr: false });

export function PluginFileViewerHost() {
  useEffect(() => registerFileViewerHost(), []);
  const view = useSyncExternalStore(subscribeFileView, currentFileView, () => null);
  // Stable per file: the preview loads again when this changes.
  const getFileContent = useMemo(
    () => (view ? async () => ({ blob: view.blob, contentType: view.blob.type }) : null),
    [view],
  );
  const close = useCallback(() => { if (view) closePluginFile(view.id); }, [view]);
  if (!view || !getFileContent) return null;
  return (
    <FilePreviewModal
      key={view.id}
      name={view.name}
      onClose={close}
      // The preview leaves Download out where the organisation turns downloads off.
      onDownload={() => { saveBlobAs(view.blob, view.name, { kind: 'attachment' }); }}
      getFileContent={getFileContent}
      autoPrint={view.print}
    />
  );
}
