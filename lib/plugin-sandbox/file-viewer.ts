// A file a plugin asked Bulwark to show in its own file preview
// (api.ui.openFile, and api.ui.print with a PDF): one at a time, held as a
// Blob in memory, shown by components/plugins/plugin-file-viewer-host.tsx.
// The preview makes its blob: URL from it and revokes the URL when it closes;
// the Blob goes when the request is dropped here.

export interface PluginFileView {
  id: number;
  pluginId: string;
  name: string;
  blob: Blob;
  /** Open the print dialog once the file is on screen (api.ui.print with a PDF). */
  print: boolean;
}

let current: PluginFileView | null = null;
let nextId = 1;
let hosts = 0;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function subscribeFileView(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function currentFileView(): PluginFileView | null {
  return current;
}

/** The viewer host is on screen; returns its unregister. */
export function registerFileViewerHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
    if (hosts === 0 && current) {
      current = null;
      changed();
    }
  };
}

/** Show the file, in place of one shown before. False when no viewer is mounted in this window. */
export function showPluginFile(view: Omit<PluginFileView, 'id'>): boolean {
  if (hosts === 0) return false;
  current = { ...view, id: nextId++ };
  changed();
  return true;
}

/** The user closed it: the file is dropped. */
export function closePluginFile(id: number): void {
  if (current?.id !== id) return;
  current = null;
  changed();
}

/** A plugin stopped: what it showed goes with it. */
export function closePluginFilesOf(pluginId: string): void {
  if (current?.pluginId !== pluginId) return;
  current = null;
  changed();
}

/** Tests. */
export function resetFileViews(): void {
  current = null;
  hosts = 0;
  listeners.clear();
}
