import { create } from 'zustand';
import { WebDAVClient, type WebDAVResource } from '@/lib/webdav/client';

interface UploadProgress {
  name: string;
  loaded: number;
  total: number;
  current: number;
  totalFiles: number;
}

interface ClipboardState {
  mode: 'cut' | 'copy';
  paths: string[];
  names: string[];
  sourcePath: string;
}

interface UndoAction {
  type: 'rename' | 'move';
  // For rename: from/to paths
  // For move: array of {from, to} pairs
  entries: { from: string; to: string }[];
  sourcePath: string;
}

interface WebDAVState {
  currentPath: string;
  resources: WebDAVResource[];
  isLoading: boolean;
  error: string | null;
  supportsWebDAV: boolean | null;
  selectedResources: Set<string>;
  uploadProgress: UploadProgress | null;
  webdavClient: WebDAVClient | null;
  clipboard: ClipboardState | null;
  uploadAbortController: AbortController | null;
  favorites: string[];
  recentFiles: { name: string; path: string; timestamp: number }[];
  lastAction: UndoAction | null;

  // Actions
  initClient: () => void;
  checkSupport: () => Promise<boolean>;
  navigate: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  createDirectory: (name: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  uploadFiles: (files: File[]) => Promise<void>;
  uploadFolder: (files: File[]) => Promise<void>;
  cancelUpload: () => void;
  deleteResource: (name: string) => Promise<void>;
  deleteResources: (names: string[]) => Promise<void>;
  renameResource: (oldName: string, newName: string) => Promise<void>;
  downloadResource: (name: string) => Promise<void>;
  downloadResources: (names: string[]) => Promise<void>;
  getImageUrl: (name: string) => Promise<string>;
  getFileContent: (name: string) => Promise<{ blob: Blob; contentType: string }>;
  createTextFile: (name: string) => Promise<void>;
  duplicateResource: (name: string) => Promise<void>;
  moveToFolder: (names: string[], targetFolder: string) => Promise<void>;
  cutResources: (names: string[]) => void;
  copyResources: (names: string[]) => void;
  pasteResources: () => Promise<void>;
  selectResource: (name: string | null) => void;
  toggleSelect: (name: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setSelection: (names: Set<string>) => void;
  listPath: (path: string) => Promise<WebDAVResource[]>;
  toggleFavorite: (path: string) => void;
  addRecentFile: (name: string, path: string) => void;
  undoLastAction: () => Promise<void>;
}

function getUniqueName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name)) return name;
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex > 0 ? name.substring(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.substring(dotIndex) : '';
  let counter = 1;
  while (existingNames.has(`${base} (${counter})${ext}`)) counter++;
  return `${base} (${counter})${ext}`;
}

export const useWebDAVStore = create<WebDAVState>((set, get) => ({
  currentPath: '/',
  resources: [],
  isLoading: false,
  error: null,
  supportsWebDAV: null,
  selectedResources: new Set<string>(),
  uploadProgress: null,
  webdavClient: null,
  clipboard: null,
  uploadAbortController: null,
  lastAction: null,
  favorites: (() => {
    try { return JSON.parse(localStorage.getItem('webdav-favorites') || '[]'); } catch { return []; }
  })(),
  recentFiles: (() => {
    try { return JSON.parse(localStorage.getItem('webdav-recent-files') || '[]'); } catch { return []; }
  })(),

  initClient: () => {
    const client = new WebDAVClient();
    set({ webdavClient: client });
  },

  checkSupport: async () => {
    const { webdavClient } = get();
    if (!webdavClient) return false;

    try {
      const supported = await webdavClient.checkSupport();
      set({ supportsWebDAV: supported });
      return supported;
    } catch {
      set({ supportsWebDAV: false });
      return false;
    }
  },

  navigate: async (path: string) => {
    const { webdavClient } = get();
    if (!webdavClient) return;

    set({ isLoading: true, error: null, currentPath: path, selectedResources: new Set() });

    // Remember last directory
    try { localStorage.setItem('webdav-last-path', path); } catch { /* ignore */ }

    try {
      const resources = await webdavClient.list(path);
      set({ resources, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to list directory',
        isLoading: false,
        resources: [],
      });
    }
  },

  refresh: async () => {
    const { currentPath, navigate } = get();
    await navigate(currentPath);
  },

  createDirectory: async (name: string) => {
    const { webdavClient, currentPath, refresh } = get();
    if (!webdavClient) return;

    const fullPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    await webdavClient.createDirectory(fullPath);
    await refresh();
  },

  uploadFile: async (file: File) => {
    const { webdavClient, currentPath } = get();
    if (!webdavClient) return;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    const fullPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
    set({ uploadProgress: { name: file.name, loaded: 0, total: file.size, current: 1, totalFiles: 1 } });

    try {
      await webdavClient.uploadFile(fullPath, file, undefined, (loaded: number, total: number) => {
        set({ uploadProgress: { name: file.name, loaded, total, current: 1, totalFiles: 1 } });
      }, abortController.signal);
    } finally {
      set({ uploadProgress: null, uploadAbortController: null });
    }
  },

  uploadFiles: async (files: File[]) => {
    const { webdavClient, currentPath, resources } = get();
    if (!webdavClient) return;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    const totalFiles = files.length;
    const existingNames = new Set(resources.map(r => r.name));

    for (let i = 0; i < files.length; i++) {
      if (abortController.signal.aborted) break;
      const file = files[i];
      const uniqueName = getUniqueName(file.name, existingNames);
      existingNames.add(uniqueName);
      const fullPath = currentPath === '/' ? `/${uniqueName}` : `${currentPath}/${uniqueName}`;
      set({ uploadProgress: { name: file.name, loaded: 0, total: file.size, current: i + 1, totalFiles } });

      try {
        await webdavClient.uploadFile(fullPath, file, undefined, (loaded: number, total: number) => {
          set({ uploadProgress: { name: file.name, loaded, total, current: i + 1, totalFiles } });
        }, abortController.signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break;
        set({ uploadProgress: null, uploadAbortController: null });
        throw err;
      }
    }
    set({ uploadProgress: null, uploadAbortController: null });
    await get().refresh();
  },

  cancelUpload: () => {
    const { uploadAbortController } = get();
    if (uploadAbortController) {
      uploadAbortController.abort();
      set({ uploadProgress: null, uploadAbortController: null });
    }
  },

  uploadFolder: async (files: File[]) => {
    const { webdavClient, currentPath } = get();
    if (!webdavClient || files.length === 0) return;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    const totalFiles = files.length;

    // Collect all unique directory paths to create
    const dirs = new Set<string>();
    for (const file of files) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = relativePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }

    // Create directories first (sorted by depth)
    const sortedDirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const dir of sortedDirs) {
      if (abortController.signal.aborted) break;
      const fullPath = currentPath === '/' ? `/${dir}` : `${currentPath}/${dir}`;
      try {
        await webdavClient.createDirectory(fullPath);
      } catch {
        // Directory may already exist
      }
    }

    // Upload files
    for (let i = 0; i < files.length; i++) {
      if (abortController.signal.aborted) break;
      const file = files[i];
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const fullPath = currentPath === '/' ? `/${relativePath}` : `${currentPath}/${relativePath}`;
      set({ uploadProgress: { name: relativePath, loaded: 0, total: file.size, current: i + 1, totalFiles } });

      try {
        await webdavClient.uploadFile(fullPath, file, undefined, (loaded: number, total: number) => {
          set({ uploadProgress: { name: relativePath, loaded, total, current: i + 1, totalFiles } });
        }, abortController.signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break;
        set({ uploadProgress: null, uploadAbortController: null });
        throw err;
      }
    }
    set({ uploadProgress: null, uploadAbortController: null });
    await get().refresh();
  },

  deleteResource: async (name: string) => {
    const { webdavClient, currentPath, refresh } = get();
    if (!webdavClient) return;

    const fullPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    await webdavClient.delete(fullPath);
    await refresh();
  },

  deleteResources: async (names: string[]) => {
    const { webdavClient, currentPath, refresh } = get();
    if (!webdavClient) return;

    for (const name of names) {
      const fullPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
      await webdavClient.delete(fullPath);
    }
    set({ selectedResources: new Set() });
    await refresh();
  },

  renameResource: async (oldName: string, newName: string) => {
    const { webdavClient, currentPath, refresh } = get();
    if (!webdavClient) return;

    const oldPath = currentPath === '/' ? `/${oldName}` : `${currentPath}/${oldName}`;
    const newPath = currentPath === '/' ? `/${newName}` : `${currentPath}/${newName}`;
    await webdavClient.move(oldPath, newPath);
    set({ lastAction: { type: 'rename', entries: [{ from: oldPath, to: newPath }], sourcePath: currentPath } });
    await refresh();
  },

  downloadResource: async (name: string) => {
    const { webdavClient, currentPath } = get();
    if (!webdavClient) return;

    const fullPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    const { blob, filename } = await webdavClient.downloadFile(fullPath);

    // Trigger browser download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  downloadResources: async (names: string[]) => {
    const { downloadResource } = get();
    for (const name of names) {
      await downloadResource(name);
    }
  },

  getImageUrl: async (name: string) => {
    const { webdavClient, currentPath } = get();
    if (!webdavClient) throw new Error('No client');

    const fullPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    const { blob } = await webdavClient.downloadFile(fullPath);
    return URL.createObjectURL(blob);
  },

  getFileContent: async (name: string) => {
    const { webdavClient, currentPath } = get();
    if (!webdavClient) throw new Error('No client');

    const fullPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    const { blob, contentType } = await webdavClient.downloadFile(fullPath);
    return { blob, contentType };
  },

  createTextFile: async (name: string) => {
    const { webdavClient, currentPath, refresh } = get();
    if (!webdavClient) return;

    const fullPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    await webdavClient.uploadFile(fullPath, new Blob([''], { type: 'text/plain' }), 'text/plain');
    await refresh();
  },

  duplicateResource: async (name: string) => {
    const { webdavClient, currentPath, refresh } = get();
    if (!webdavClient) return;

    const srcPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    const dotIdx = name.lastIndexOf('.');
    const copyName = dotIdx > 0
      ? `${name.substring(0, dotIdx)} (copy)${name.substring(dotIdx)}`
      : `${name} (copy)`;
    const destPath = currentPath === '/' ? `/${copyName}` : `${currentPath}/${copyName}`;
    await webdavClient.copy(srcPath, destPath);
    await refresh();
  },

  moveToFolder: async (names: string[], targetFolder: string) => {
    const { webdavClient, currentPath, refresh } = get();
    if (!webdavClient) return;

    const targetBase = currentPath === '/' ? `/${targetFolder}` : `${currentPath}/${targetFolder}`;
    const entries: { from: string; to: string }[] = [];
    for (const name of names) {
      const oldPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
      const newPath = `${targetBase}/${name}`;
      await webdavClient.move(oldPath, newPath);
      entries.push({ from: oldPath, to: newPath });
    }
    set({ selectedResources: new Set(), lastAction: { type: 'move', entries, sourcePath: currentPath } });
    await refresh();
  },

  cutResources: (names: string[]) => {
    const { currentPath } = get();
    const paths = names.map(n => currentPath === '/' ? `/${n}` : `${currentPath}/${n}`);
    set({ clipboard: { mode: 'cut', paths, names, sourcePath: currentPath } });
  },

  copyResources: (names: string[]) => {
    const { currentPath } = get();
    const paths = names.map(n => currentPath === '/' ? `/${n}` : `${currentPath}/${n}`);
    set({ clipboard: { mode: 'copy', paths, names, sourcePath: currentPath } });
  },

  pasteResources: async () => {
    const { webdavClient, currentPath, clipboard, refresh } = get();
    if (!webdavClient || !clipboard) return;

    const entries: { from: string; to: string }[] = [];
    for (let i = 0; i < clipboard.paths.length; i++) {
      const srcPath = clipboard.paths[i];
      const destPath = currentPath === '/' ? `/${clipboard.names[i]}` : `${currentPath}/${clipboard.names[i]}`;

      if (clipboard.mode === 'cut') {
        await webdavClient.move(srcPath, destPath);
        entries.push({ from: srcPath, to: destPath });
      } else {
        await webdavClient.copy(srcPath, destPath);
      }
    }

    if (clipboard.mode === 'cut') {
      set({ clipboard: null, lastAction: { type: 'move', entries, sourcePath: currentPath } });
    }
    await refresh();
  },

  selectResource: (name: string | null) => {
    set({ selectedResources: name ? new Set([name]) : new Set() });
  },

  toggleSelect: (name: string) => {
    const { selectedResources } = get();
    const next = new Set(selectedResources);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    set({ selectedResources: next });
  },

  selectAll: () => {
    const { resources } = get();
    set({ selectedResources: new Set(resources.map(r => r.name)) });
  },

  clearSelection: () => {
    set({ selectedResources: new Set() });
  },

  setSelection: (names: Set<string>) => {
    set({ selectedResources: new Set(names) });
  },

  listPath: async (path: string) => {
    const { webdavClient } = get();
    if (!webdavClient) return [];
    return webdavClient.list(path);
  },

  toggleFavorite: (path: string) => {
    const { favorites } = get();
    const next = favorites.includes(path)
      ? favorites.filter(f => f !== path)
      : [...favorites, path];
    set({ favorites: next });
    try { localStorage.setItem('webdav-favorites', JSON.stringify(next)); } catch { /* ignore */ }
  },

  addRecentFile: (name: string, path: string) => {
    const { recentFiles } = get();
    const entry = { name, path, timestamp: Date.now() };
    const filtered = recentFiles.filter(r => r.path !== path);
    const next = [entry, ...filtered].slice(0, 20);
    set({ recentFiles: next });
    try { localStorage.setItem('webdav-recent-files', JSON.stringify(next)); } catch { /* ignore */ }
  },

  undoLastAction: async () => {
    const { webdavClient, lastAction, refresh } = get();
    if (!webdavClient || !lastAction) return;

    // Reverse all entries
    for (const entry of lastAction.entries) {
      await webdavClient.move(entry.to, entry.from);
    }
    set({ lastAction: null });
    await refresh();
  },
}));
